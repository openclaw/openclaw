import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { seedSkillLibrarySelection } from "../../skills/library/selection.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import { readWorkspaceSkillSources } from "../../skills/loading/workspace-skill-loader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
} from "../../skills/loading/workspace-skill-sources.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { skillsHandlers } from "./skills.js";
import { callGatewayHandler } from "./skills.test-helpers.js";
import type { GatewayClient } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

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
  await writeSkill({
    dir: path.join(gateway, "skills", "stale"),
    name: "stale",
    description: "Stale",
  });
  await writeSkill({
    dir: path.join(remote, "skills", "available"),
    name: "available",
    description: "Remote skill",
    metadata: JSON.stringify({
      openclaw: {
        os: [hostPlatform],
        requires: { bins: ["host-tool"] },
        install: [{ id: "host", kind: "node", package: "host-tool", os: [hostPlatform] }],
      },
    }),
  });
  await writeSkill({
    dir: path.join(remote, "skills", "installer"),
    name: "installer",
    description: "Workspace dependency recipes",
    metadata: JSON.stringify({
      openclaw: {
        install: [
          { id: "brew", kind: "brew", formula: "fixture-tool" },
          { id: "host", kind: "node", package: "host-tool", os: [hostPlatform] },
          { id: "gateway", kind: "node", package: "gateway-tool", os: [process.platform] },
        ],
      },
    }),
  });
  await writeSkill({
    dir: path.join(remote, "skills", "missing"),
    name: "missing",
    description: "Missing dependency",
    metadata: JSON.stringify({ openclaw: { requires: { bins: ["absent-tool"] } } }),
  });
  await fs.writeFile(path.join(remote, "skills", "available", "skill-card.md"), "# Remote card\n");
  const config = {
    plugins: { enabled: false },
    agents: { list: [{ id: "main", workspace: gateway }] },
  };
  const loadSkills = vi.fn(async (request: WorkspaceSkillSourceRequest) => ({
    ...readWorkspaceSkillSources({
      ...request,
      sourcePlan: resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
    }),
    runtime: { platform: hostPlatform, bins: ["host-tool", "brew"] },
  }));
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
          { name: "installer", install: [{ id: "brew" }] },
          { name: "missing", eligible: false, missing: { bins: ["absent-tool"] } },
        ],
      },
    });
    expect(JSON.stringify(status.response)).not.toContain("# Remote card");
    expect(await call("skills.skillCard", { skillKey: "available" })).toMatchObject({
      ok: true,
      response: { skillKey: "available", content: "# Remote card\n" },
    });
    expect(loadSkills).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: { skillCardKey: "available" } }),
    );
    expect(await call("skills.bins")).toMatchObject({
      ok: true,
      response: { bins: ["absent-tool", "host-tool"] },
    });
  } finally {
    release();
  }
});

it.each(["unchanged", "revoked", "replaced", "workspace-changed"] as const)(
  "checks session access after remote discovery: %s",
  async (change) => {
    await withOpenClawTestState({ label: "remote-skill-session-access" }, async (state) => {
      const cfg = {
        plugins: { enabled: false },
        skills: { load: { watch: false } },
        agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
      };
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      const authority = {
        profileId: alice.id,
        scopes: ["operator.read", "operator.write"],
        getConfig: () => cfg,
        assertCurrent: () => {},
      };
      await saveSkillLibrary(authority, {
        slug: "private-procedure",
        content:
          "---\nname: private-procedure\ndescription: Session-pinned private procedure\n---\nInstructions\n",
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
          skillLibrarySelections: seedSkillLibrarySelection(authority),
        },
      );
      const entered = createDeferred();
      const resume = createDeferred();
      const release = registerAgentWorkspaceAccess(state.workspaceDir, {
        bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
        loadSkills: async () => {
          entered.resolve();
          await resume.promise;
          return {
            entries: [],
            executionEntries: [],
            runtime: { platform: process.platform, bins: [] },
            status: {
              workspaceDir: state.workspaceDir,
              managedSkillsDir: path.join(state.stateDir, "skills"),
              files: [],
            },
          };
        },
      });
      const result = callGatewayHandler(
        skillsHandlers,
        "skills.status",
        { sessionKey },
        {
          context: { getRuntimeConfig: () => cfg },
          client: {
            authenticatedUserProfile: { profileId: bob.id },
            connect: { scopes: ["operator.read", "operator.write"] },
          } as GatewayClient,
        },
      );
      try {
        await entered.promise;
        if (change !== "unchanged") {
          await patchSessionEntryCore({ agentId: "main", sessionKey }, () =>
            change === "revoked"
              ? { visibility: "draft" }
              : change === "workspace-changed"
                ? { spawnedCwd: path.join(state.root, "replacement-project") }
                : { sessionId: "replacement" },
          );
        }
        resume.resolve();
        const response = await result;
        if (change === "unchanged") {
          expect(response).toMatchObject({
            ok: true,
            response: {
              skills: expect.arrayContaining([
                expect.objectContaining({
                  description: "Session-pinned private procedure",
                  source: "openclaw-library",
                }),
              ]),
            },
          });
        } else {
          expect(response).toMatchObject({
            ok: false,
            response: undefined,
            error: { code: "INVALID_REQUEST" },
          });
        }
      } finally {
        resume.resolve();
        try {
          await result;
        } finally {
          release();
        }
      }
    });
  },
);
