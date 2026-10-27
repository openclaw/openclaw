import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateClawLifecyclePlanResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ClawLifecyclePlanResult } from "../../../packages/gateway-protocol/src/schema/claws.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { ensureAgentWorkspace, isWorkspaceBootstrapPending } from "../../agents/workspace.js";
import * as deletionJournal from "../../state/agent-deletion-journal.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  authorizeOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../method-scopes.js";
import { clawsAddHandlers } from "./claws-add.js";
import type { RespondFn } from "./types.js";

// No Gateway config reloader runs here; confirm each Add config write as applied.
vi.mock("../../config/runtime-write-application.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/runtime-write-application.js")>();
  return {
    ...actual,
    createRuntimeConfigWriteApplication: (
      ...args: Parameters<typeof actual.createRuntimeConfigWriteApplication>
    ) => {
      const application = actual.createRuntimeConfigWriteApplication(...args);
      application.claim()?.settle("applied");
      return application;
    },
  };
});

const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function fixture() {
  const state = await createOpenClawTestState({ label: "local-claw-add", applyEnv: true });
  cleanups.push(state.cleanup);
  await state.writeConfig(enabled);
  const localPath = state.path("imported-bot");
  await fs.mkdir(localPath);
  await fs.writeFile(
    path.join(localPath, "package.json"),
    JSON.stringify({ name: "@fixture/local-bot", version: "1.0.0", openclaw: { claw: "CLAW.md" } }),
  );
  await fs.writeFile(
    path.join(localPath, "CLAW.md"),
    "---\nschemaVersion: 1\nagent:\n  id: local-bot\n  name: Local Bot\n  identity:\n    avatar: avatars/bot.png\nworkspace:\n  files:\n    - source: icon.png\n      path: avatars/bot.png\n    - source: memory.md\n      path: MEMORY.md\n    - source: research.md\n      path: skills/research/SKILL.md\n---\n\nYou are a research bot.\n",
  );
  await fs.writeFile(path.join(localPath, "memory.md"), "Use primary sources.\n");
  await fs.writeFile(path.join(localPath, "research.md"), "Ask which sources to research.\n");
  const icon = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(path.join(localPath, "icon.png"), icon);
  const bootstrap = "Read skills/research/SKILL.md and ask the user to finish setup.\n";
  await fs.writeFile(path.join(localPath, "BOOTSTRAP.md"), bootstrap);
  return { state, source: { localPath }, icon, bootstrap };
}

async function request(
  method: "claws.add.plan" | "claws.add.apply",
  params: Record<string, unknown>,
  hasCurrentClientAuthority?: () => boolean,
) {
  const replies: Parameters<RespondFn>[] = [];
  await expectDefined(
    clawsAddHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method },
    params,
    respond: (...args) => replies.push(args),
    context: {
      getRuntimeConfig: () => enabled,
      localEmbedded: true,
      cron: {
        list: async () => [],
        removeAgentJobsTransactional: async (_agentId: string, run: () => Promise<void>) =>
          await run(),
      },
    } as never,
    client: null,
    hasCurrentClientAuthority,
    isWebchatConnect: () => false,
  });
  return expectDefined(replies[0], "Gateway response");
}

describe("local Claw Add through the Gateway", () => {
  it("requires admin scope to inspect host files and preserves catalog read access", () => {
    const local = { source: { localPath: "/tmp/imported-bot" } };
    expect(resolveLeastPrivilegeOperatorScopesForMethod("claws.add.plan", local)).toEqual([
      "operator.admin",
    ]);
    expect(authorizeOperatorScopesForMethod("claws.add.plan", ["operator.read"], local)).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(
      authorizeOperatorScopesForMethod("claws.add.plan", ["operator.read"], {
        source: { packageName: "@openclaw/research", version: "1.0.0" },
      }),
    ).toEqual({ allowed: true });
  });

  it("installs a local package with its instructions, first-run setup, and avatar", async () => {
    const { state, source, icon, bootstrap } = await fixture();
    const preview = await request("claws.add.plan", { source });
    expect(preview[0], JSON.stringify(preview[2])).toBe(true);
    const plan = preview[1] as ClawLifecyclePlanResult;
    expect(validateClawLifecyclePlanResult(plan)).toBe(true);
    expect(plan.manifestDisclosure?.source).toMatchObject({ localName: "@fixture/local-bot" });
    expect(plan.blockers).toEqual([]);
    expect(plan.target.agentId).toBe("local-bot");
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", id: "BOOTSTRAP.md" }),
    );
    const applied = await request("claws.add.apply", { source, planIntegrity: plan.planIntegrity });
    expect(applied[0], JSON.stringify(applied[2])).toBe(true);
    expect(applied[1]).toMatchObject({
      agentId: "local-bot",
      status: "complete",
      readiness: { ready: true },
    });
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(config.agents.entries["local-bot"].identity.avatar).toBe("avatars/bot.png");
    const workspace = config.agents.entries["local-bot"].workspace;
    expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toContain(
      "You are a research bot.",
    );
    expect(await fs.readFile(path.join(workspace, "avatars/bot.png"))).toEqual(icon);
    expect(await fs.readFile(path.join(workspace, "BOOTSTRAP.md"), "utf8")).toBe(bootstrap);
    const prepared = await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
    expect(prepared.bootstrapPending).toBe(true);
    const context = await resolveBootstrapContextForRun({ workspaceDir: workspace, config });
    expect(context.contextFiles).toContainEqual({
      path: path.join(workspace, "BOOTSTRAP.md"),
      content: bootstrap.trimEnd(),
    });
    await fs.unlink(path.join(workspace, "BOOTSTRAP.md"));
    await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(false);
  });

  it("rejects a package changed after preview without creating the agent", async () => {
    const { state, source } = await fixture();
    const preview = await request("claws.add.plan", { source });
    expect(preview[0], JSON.stringify(preview[2])).toBe(true);
    const plan = preview[1] as ClawLifecyclePlanResult;
    await fs.appendFile(path.join(source.localPath, "CLAW.md"), "Changed instructions.\n");
    const applied = await request("claws.add.apply", { source, planIntegrity: plan.planIntegrity });
    expect(applied[0]).toBe(false);
    expect(applied[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("changed since review"),
    });
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(config.agents?.entries?.["local-bot"]).toBeUndefined();
  });

  it("preserves first-run setup when retrying an installation rolled back before agent creation", async () => {
    const { state, source, bootstrap } = await fixture();
    const preview = await request("claws.add.plan", { source });
    const plan = preview[1] as ClawLifecyclePlanResult;
    vi.spyOn(deletionJournal, "readAgentDeletionJournalAsync").mockRejectedValueOnce(
      new Error("Agent deletion journal unavailable"),
    );
    const failed = await request("claws.add.apply", { source, planIntegrity: plan.planIntegrity });
    expect(failed[1]).toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("Agent deletion journal unavailable") },
    });
    const retryPreview = await request("claws.add.plan", { source });
    const retryPlan = retryPreview[1] as ClawLifecyclePlanResult;
    const retried = await request("claws.add.apply", {
      source,
      planIntegrity: retryPlan.planIntegrity,
    });
    expect(retried[1]).toMatchObject({ status: "complete", agentId: "local-bot" });
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    const workspace = config.agents.entries["local-bot"].workspace;
    expect(await fs.readFile(path.join(workspace, "BOOTSTRAP.md"), "utf8")).toBe(bootstrap);
  });

  it("rejects relative paths and withholds a local preview after authority is revoked", async () => {
    const { source } = await fixture();
    const relative = await request("claws.add.plan", { source: { localPath: "imported-bot" } });
    expect(relative[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("absolute path on the Gateway host"),
    });
    let checks = 0;
    const revoked = await request("claws.add.plan", { source }, () => ++checks < 3);
    expect(checks).toBe(3);
    expect(revoked[0]).toBe(false);
    expect(revoked[1]).toBeUndefined();
    expect(revoked[2]).toMatchObject({ code: "FORBIDDEN" });
  });
});
