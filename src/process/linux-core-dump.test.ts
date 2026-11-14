import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { prepareAgentCoreDumpLimit } from "./linux-core-dump.js";

afterEach(() => vi.restoreAllMocks());

it("requires a trusted prlimit and supports the NixOS system profile", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  let installed = false;
  const nixPrlimit = "/run/current-system/sw/bin/prlimit";
  vi.spyOn(fs, "accessSync").mockImplementation((candidate) => {
    if (!installed || candidate !== nixPrlimit) {
      throw Object.assign(new Error("missing executable"), { code: "ENOENT" });
    }
  });
  expect(prepareAgentCoreDumpLimit("node", [], "gateway-internal")).toEqual({
    command: "node",
    args: [],
  });
  expect(() => prepareAgentCoreDumpLimit("node", [], "agent-tool")).toThrow("install util-linux");
  installed = true;
  expect(prepareAgentCoreDumpLimit("node", ["-e", "process.abort()"], "agent-tool")).toEqual({
    command: nixPrlimit,
    args: ["--core=0:0", "--", "node", "-e", "process.abort()"],
  });
});
