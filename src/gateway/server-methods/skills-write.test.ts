import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

const mocks = vi.hoisted(() => ({ workspaceDir: "" }));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

const { skillsWriteHandlers } = await import("./skills-write.js");

describe("skills write gateway handlers", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skills-write-gateway-state-",
    });
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-write-gateway-");
  });

  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("validates, proposes, applies, writes directly, and refreshes", async () => {
    const directContent =
      "---\nname: direct-gateway\ndescription: Write through the gateway service\n---\n\n# Direct\n";
    const validate = await callGatewayHandler(skillsWriteHandlers, "skills.write.validate", {
      name: "direct-gateway",
      content: directContent,
    });
    expect(validate).toMatchObject({
      ok: true,
      response: { name: "direct-gateway", scan: { state: "clean" } },
    });

    const propose = await callGatewayHandler(skillsWriteHandlers, "skills.write.propose", {
      kind: "create",
      name: "gateway-service-proposal",
      description: "Propose through the gateway service",
      content: "# Gateway Service Proposal\n",
    });
    expect(propose.ok).toBe(true);
    const proposalId = (propose.response as { record: { id: string } }).record.id;

    const apply = await callGatewayHandler(skillsWriteHandlers, "skills.write.applyProposal", {
      proposalId,
    });
    expect(apply).toMatchObject({ ok: true, response: { record: { status: "applied" } } });

    const direct = await callGatewayHandler(skillsWriteHandlers, "skills.write.direct", {
      mode: "create",
      name: "direct-gateway",
      content: directContent,
      refresh: false,
    });
    expect(direct).toMatchObject({
      ok: true,
      response: { rollback: { action: "create" } },
    });
    expect((direct.response as { snapshotVersion?: number }).snapshotVersion).toBeUndefined();

    const refresh = await callGatewayHandler(
      skillsWriteHandlers,
      "skills.write.refreshSnapshot",
      {},
    );
    expect(refresh).toMatchObject({ ok: true, response: { snapshotVersion: expect.any(Number) } });
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "direct-gateway", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Direct");
  });
});
