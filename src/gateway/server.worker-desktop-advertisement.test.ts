// Full Gateways advertise desktop capabilities independently of live Labs policy.
import { describe, expect, it } from "vitest";
import { writeConfigFile } from "../config/config.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("cloud worker desktop method advertisement", () => {
  it.each([{ desktop: undefined }, { desktop: true }])(
    "advertises worker methods and enforces Labs policy when it is $desktop",
    async (testCase) => {
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
      await writeConfigFile({
        cloudWorkers: {
          ...(testCase.desktop === undefined ? {} : { desktop: testCase.desktop }),
          profiles: {
            development: {
              provider: "test-worker-provider",
              settings: {},
            },
          },
        },
      });
      const { server, ws } = await startServerWithClient(undefined, { auth: { mode: "none" } });
      try {
        const hello = await connectOk(ws);
        const methods = (hello as { features?: { methods?: string[] } }).features?.methods ?? [];

        expect(methods).toContain("sessions.dispatch");
        expect(methods).toContain("desktop.observe");
        expect(methods).toContain("desktop.launch");
        expect(methods).toContain("worker.desktop.observe");
        expect(methods).toContain("worker.desktop.launch");
        const observed = await rpcReq(ws, "worker.desktop.observe", {
          environmentId: "missing-advertisement-worker",
        });
        expect(observed).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message:
              testCase.desktop === true
                ? "Unknown worker environment: missing-advertisement-worker"
                : expect.stringContaining("worker desktop observe is disabled"),
          },
        });
      } finally {
        ws.close();
        await server.close();
      }
    },
  );

  it("advertises worker desktop methods with host-only configuration while enforcing their disabled policy", async () => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    await writeConfigFile({ desktop: { host: { enabled: true } } });
    const { server, ws } = await startServerWithClient(undefined, { auth: { mode: "none" } });
    try {
      const hello = await connectOk(ws);
      const methods = (hello as { features?: { methods?: string[] } }).features?.methods ?? [];
      expect(methods).toContain("desktop.observe");
      expect(methods).toContain("desktop.launch");
      expect(methods).toContain("worker.desktop.observe");
      expect(methods).toContain("worker.desktop.launch");
      const observed = await rpcReq(ws, "worker.desktop.observe", {
        environmentId: "missing-advertisement-worker",
      });
      expect(observed).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("worker desktop observe is disabled"),
        },
      });
    } finally {
      ws.close();
      await server.close();
    }
  });
});
