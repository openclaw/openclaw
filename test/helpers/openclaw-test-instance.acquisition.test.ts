import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveGatewayPort } from "../../src/config/paths.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayUrlOverride } from "../../src/gateway/client-bootstrap.js";
import { captureFullEnv, withEnvAsync } from "../../src/test-utils/env.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

describe("createOpenClawTestInstance acquisition", () => {
  it.each(["state", "merge", "serialization", "write", "cleanup"] as const)(
    "cleans up available resources after %s acquisition failure",
    async (stage) => {
      const previousEnv = { ...process.env };
      const snapshot = captureFullEnv();
      const failure = new Error(`config ${stage} failed`);
      let root: string | undefined;
      let writeFailure: unknown;
      const cleanupFailure = new Error("state cleanup failed");
      const serverSpy = vi.spyOn(net, "createServer");
      let reservedPort: number | undefined;
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        if (args[0].endsWith("instance-wrapper-failure-")) {
          const address = serverSpy.mock.results[0]?.value.address();
          reservedPort = address && typeof address !== "string" ? address.port : undefined;
          expect(reservedPort).toBeTypeOf("number");
          if (stage === "state") {
            throw failure;
          }
        }
        const allocated = await mkdtemp(...args);
        if (args[0].endsWith("instance-wrapper-failure-")) {
          root = await fs.realpath(allocated);
        }
        return allocated;
      });
      const rm = fs.rm;
      const cleanupSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (stage === "cleanup" && args[0] === root) {
          throw cleanupFailure;
        }
        return rm(...args);
      });
      const writeFile = fs.writeFile;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (
          stage === "write" &&
          root &&
          args[0] === path.join(root, "home", ".openclaw", "openclaw.json")
        ) {
          // A directory at the config path makes the real filesystem write reject.
          await fs.mkdir(args[0]);
          try {
            await writeFile(...args);
          } catch (error) {
            writeFailure = error;
            throw error;
          }
          return;
        }
        return writeFile(...args);
      });
      const failConfig = () => {
        expect(root).toBeDefined();
        throw failure;
      };
      const config =
        stage === "merge" || stage === "cleanup"
          ? {
              get gateway() {
                return failConfig();
              },
            }
          : stage === "serialization"
            ? { toJSON: failConfig }
            : {};
      try {
        const rejected = await createOpenClawTestInstance({
          name: "acquisition-failure",
          state: { prefix: "instance-wrapper-failure-" },
          config,
        }).catch((error: unknown) => error);
        if (stage === "write") {
          expect(writeFailure).toMatchObject({ code: "EISDIR" });
          expect(rejected).toBe(writeFailure);
        } else if (stage === "cleanup") {
          expect(rejected).toBeInstanceOf(AggregateError);
          expect((rejected as AggregateError).errors).toEqual([failure, cleanupFailure]);
        } else {
          expect(rejected).toBe(failure);
        }
        expect(process.env).toEqual(previousEnv);
        if (stage !== "state") {
          expect(root).toBeDefined();
          if (stage === "cleanup") {
            await expect(fs.stat(root!)).resolves.toBeDefined();
          } else {
            await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
        const competitor = net.createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            competitor.once("error", reject);
            competitor.listen(reservedPort!, "127.0.0.1", resolve);
          });
        } finally {
          if (competitor.listening) {
            await new Promise<void>((resolve, reject) => {
              competitor.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
      } finally {
        allocationSpy.mockRestore();
        writeSpy.mockRestore();
        cleanupSpy.mockRestore();
        serverSpy.mockRestore();
        snapshot.restore();
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

type EndpointEnv = {
  OPENCLAW_GATEWAY_PORT?: string;
  OPENCLAW_GATEWAY_URL?: string;
};
const port = 19701;
const inheritedUrl = "wss://inherited.fixture.invalid";
const explicitUrl = "wss://explicit.fixture.invalid";
const cases: Array<{
  name: string;
  inherited: EndpointEnv;
  explicit?: EndpointEnv;
  expected: { port: number; override: { url?: string; source?: "env" } };
}> = [
  { name: "clean environment", inherited: {}, expected: { port, override: {} } },
  {
    name: "inherited port",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702" },
    expected: { port, override: {} },
  },
  {
    name: "inherited URL",
    inherited: { OPENCLAW_GATEWAY_URL: inheritedUrl },
    expected: { port, override: {} },
  },
  {
    name: "explicit options.env",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    explicit: { OPENCLAW_GATEWAY_PORT: "19704", OPENCLAW_GATEWAY_URL: explicitUrl },
    expected: { port: 19704, override: { url: explicitUrl, source: "env" } },
  },
  {
    name: "explicit undefined deletion",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    explicit: { OPENCLAW_GATEWAY_PORT: undefined, OPENCLAW_GATEWAY_URL: undefined },
    expected: { port, override: {} },
  },
];
const readParentEndpoints = (): EndpointEnv => ({
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
});

describe("test instance endpoint isolation", () => {
  it.each(cases)("preserves endpoint ownership with $name", async (scenario) => {
    const parent = readParentEndpoints();
    const inherited = {
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      ...scenario.inherited,
    };
    await runQaGatewayFixture(
      () =>
        withEnvAsync(inherited, async () => {
          // A supplied port skips reservation; this test never starts a child or listener.
          const instance = await createOpenClawTestInstance({
            name: "endpoint-isolation",
            port,
            env: { ...scenario.explicit, OPENCLAW_SKIP_CRON: "0" },
          });
          await runQaGatewayFixture(
            async () => {
              const config: OpenClawConfig = JSON.parse(
                await fs.readFile(instance.configPath, "utf8"),
              );
              expect(config.gateway?.port).toBe(instance.port);
              expect(instance.child).toBeUndefined();
              expect(instance.env.OPENCLAW_SKIP_CRON).toBe("0");
              for (const [key, value] of Object.entries(scenario.explicit ?? {})) {
                if (value === undefined) {
                  expect(Object.hasOwn(instance.env, key)).toBe(false);
                } else {
                  expect(instance.env[key]).toBe(value);
                }
              }
              expect(readParentEndpoints()).toEqual(inherited);
              expect(
                resolveGatewayUrlOverride({ env: instance.env, gatewayUrl: explicitUrl }),
              ).toEqual({ url: explicitUrl, source: "cli" });
              expect(
                resolveGatewayUrlOverride({ env: instance.env, localPortOverride: 19705 }),
              ).toEqual({});
              const actual = {
                port: resolveGatewayPort(config, instance.env),
                override: resolveGatewayUrlOverride({ env: instance.env }),
              };
              expect(actual, `FIXTURE_ENDPOINT_ISOLATION ${JSON.stringify(actual)}`).toEqual(
                scenario.expected,
              );
            },
            async () => {
              await instance.cleanup();
              await expect(fs.stat(instance.state.root)).rejects.toMatchObject({ code: "ENOENT" });
            },
          );
        }),
      async () => {
        expect(readParentEndpoints()).toEqual(parent);
      },
    );
  });
});
