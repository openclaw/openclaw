import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import {
  formatUpdateAncestryBlockMessage,
  gatewayMaintenanceBlockMessage,
} from "./update-command-handoff.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => fixture.root,
}));

let state: GatewayServiceState;
beforeEach(async () => {
  fixture.root = await fs.realpath(await makeTempWorkspace("openclaw-maintenance-guidance-"));
  state = {
    installed: true,
    loadState: { status: "loaded" },
    running: true,
    env: {},
    command: {
      programArguments: [process.execPath, path.join(fixture.root, "openclaw.mjs"), "gateway"],
    },
    runtime: { status: "running", pid: process.pid },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

describe("gatewayMaintenanceBlockMessage", () => {
  it("never advises stopping the gateway service or running update from the caller", () => {
    const message = gatewayMaintenanceBlockMessage(state, fixture.root);
    expect(message).toContain("inside the gateway process tree");
    expect(message).toContain("from a shell outside the gateway service");
    expect(message).not.toContain("stop the gateway service first");
    expect(message).not.toContain("openclaw update");
  });

  it("returns undefined when the pid is not an ancestor", () => {
    vi.spyOn(processAncestry, "getSelfAndAncestorPidsSync").mockReturnValue(new Set([process.pid]));
    state.runtime = { status: "running", pid: 2 };
    expect(gatewayMaintenanceBlockMessage(state, fixture.root)).toBeUndefined();
  });
});

describe("formatUpdateAncestryBlockMessage", () => {
  it("adds the chat handoff advice only to ancestry blocks", () => {
    const ancestry = gatewayMaintenanceBlockMessage(state, fixture.root) ?? "";
    expect(formatUpdateAncestryBlockMessage(ancestry)).toContain("/update");
    expect(formatUpdateAncestryBlockMessage("service inspection unavailable")).toBe(
      "service inspection unavailable",
    );
  });
});
