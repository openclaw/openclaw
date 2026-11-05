import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayTaskScriptPath } from "./paths.js";

describe("resolveGatewayTaskScriptPath", () => {
  it.each([
    {
      name: "uses default path when OPENCLAW_PROFILE is unset",
      env: { USERPROFILE: "C:\\Users\\test" },
      expected: path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    },
    {
      name: "uses profile-specific path when OPENCLAW_PROFILE is set to a custom value",
      env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: path.join("C:\\Users\\test", ".openclaw-jbphoenix", "gateway.cmd"),
    },
    {
      name: "prefers OPENCLAW_STATE_DIR over profile-derived defaults",
      env: {
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_PROFILE: "rescue",
        OPENCLAW_STATE_DIR: "C:\\State\\openclaw",
      },
      expected: path.join("C:\\State\\openclaw", "gateway.cmd"),
    },
    {
      name: "falls back to HOME when USERPROFILE is not set",
      env: { HOME: "/home/test", OPENCLAW_PROFILE: "default" },
      expected: path.join("/home/test", ".openclaw", "gateway.cmd"),
    },
    {
      name: "uses a custom task script file name inside the state directory",
      env: {
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_TASK_SCRIPT_NAME: "gateway-node.cmd",
      },
      expected: path.join("C:\\Users\\test", ".openclaw", "gateway-node.cmd"),
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveGatewayTaskScriptPath(env)).toBe(expected);
  });

  it.each(["nested/gateway.cmd", "nested\\gateway.cmd", "gateway..cmd"])(
    "rejects non-file task script name %s",
    (scriptName) => {
      expect(() =>
        resolveGatewayTaskScriptPath({
          USERPROFILE: "C:\\Users\\test",
          OPENCLAW_TASK_SCRIPT_NAME: scriptName,
        }),
      ).toThrow("OPENCLAW_TASK_SCRIPT_NAME must be a file name only");
    },
  );
});
