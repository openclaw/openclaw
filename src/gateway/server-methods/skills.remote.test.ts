import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { seedSkillLibrarySelection } from "../../skills/library/selection.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import { readWorkspaceSkillSources } from "../../skills/loading/workspace-skill-source-reader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
} from "../../skills/loading/workspace-skill-sources.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { skillsHandlers } from "./skills.js";
import { callGatewayHandler } from "./skills.test-helpers.js";
import type { GatewayClient } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
// Close discovery watchers before deleting roots or entering another file's fake clock.
afterEach(() => closeSkillsWatchers(true));

function writeWorkspaceSkill(workspace: string, name: string, metadata?: object) {
  return writeSkill({
    dir: path.join(workspace, "skills", name),
    name,
    description: name,
    ...(metadata ? { metadata: JSON.stringify({ openclaw: metadata }) } : {}),
  });
}

it("reads remote skill status, cards and binary requirements through the workspace binding", async () => {
  const root = tempDirs.make("gateway-remote-skills-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  const bundled = path.join(root, "bundled");
  await fs.mkdir(bundled);
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
  const gateway = path.join(root, "gateway");
  const remote = path.join(root, "remote");
  const hostPlatform = process.platform === "linux" ? "darwin" : "linux";
  await writeWorkspaceSkill(gateway, "stale");
  await writeWorkspaceSkill(remote, "available", {
    os: [hostPlatform],
    requires: { bins: ["host-tool"] },
    install: [{ id: "host", kind: "node", package: "host-tool", os: [hostPlatform] }],
  });
  await writeWorkspaceSkill(remote, "missing", {
    requires: { bins: ["absent-tool"] },
  });
  await fs.writeFile(path.join(remote, "skills", "available", "skill-card.md"), "# Remote card\n");
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: { workspace: gateway } } },
  };
  const loadSkills = async (request: WorkspaceSkillSourceRequest) => ({
    ...readWorkspaceSkillSources({
      ...request,
      sourcePlan: resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
    }),
    runtime: { platform: hostPlatform, bins: ["host-tool", "brew"] },
  });
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills,
  });
  const call = (method: string, params = {}) =>
    callGatewayHandler(skillsHandlers, method, params, {
      context: { getRuntimeConfig: () => config },
    });
  try {
    const status = await withEnvAsync({ PATH: "" }, () => call("skills.status"));
    expect(status).toMatchObject({
      ok: true,
      response: {
        skills: [
          {
            name: "available",
            eligible: true,
            platformIncompatible: false,
            install: [{ id: "host" }],
            skillCard: { present: true },
          },
          { name: "missing", eligible: false, missing: { bins: ["absent-tool"] } },
        ],
      },
    });
    expect(JSON.stringify(status.response)).not.toContain("# Remote card");
    expect(await call("skills.skillCard", { skillKey: "available" })).toMatchObject({
      ok: true,
      response: { skillKey: "available", content: "# Remote card\n" },
    });
    expect(await call("skills.bins")).toMatchObject({
      ok: true,
      response: { bins: ["absent-tool", "host-tool"] },
    });
  } finally {
    release();
  }
});

it("includes the shared session's pinned library in remote skill discovery", async () => {
  await withOpenClawTestState({ label: "remote-skill-session-access" }, async (state) => {
    const cfg = {
      plugins: { enabled: false },
      skills: { load: { watch: false } },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const authority = {
      profileId: alice.id,
      scopes: ["operator.read", "operator.write"],
      getConfig: () => cfg,
      assertCurrent: () => {},
    };
    await saveSkillLibrary(authority, {
      slug: "private",
      content: "---\nname: private\ndescription: Private procedure\n---\nInstructions\n",
      expectedRevision: null,
    });
    const sessionKey = "agent:main:shared-skills";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "shared-skills",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        skillLibrarySelections: await seedSkillLibrarySelection(authority),
      },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection({ getRuntimeConfig: () => cfg }, () => projection);
    const release = registerAgentWorkspaceAccess(state.workspaceDir, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
      loadSkills: async () => ({
        entries: [],
        executionEntries: [],
        runtime: { platform: process.platform, bins: [] },
        status: {
          workspaceDir: state.workspaceDir,
          managedSkillsDir: path.join(state.stateDir, "skills"),
          files: [],
        },
      }),
    });
    const result = callGatewayHandler(
      skillsHandlers,
      "skills.status",
      { sessionKey },
      {
        context,
        client: {
          authenticatedUserProfile: { profileId: bob.id },
          connect: { scopes: ["operator.read", "operator.write"] },
        } as GatewayClient,
      },
    );
    try {
      expect(await result).toMatchObject({
        ok: true,
        response: {
          skills: expect.arrayContaining([
            expect.objectContaining({
              description: "Private procedure",
              source: "openclaw-library",
            }),
          ]),
        },
      });
    } finally {
      projection.dispose();
      release();
    }
  });
});
