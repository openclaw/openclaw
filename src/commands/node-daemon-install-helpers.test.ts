import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { access: fsMocks.access, realpath: fsMocks.realpath },
  access: fsMocks.access,
  realpath: fsMocks.realpath,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildNodeServiceEnvironment: vi.fn((params: { env: Record<string, string | undefined> }) => ({
    ...params.env,
    OPENCLAW_SERVICE_VERSION: "1.0.0",
  })),
}));

const originalArgv = [...process.argv];

import { buildNodeInstallPlan } from "./node-daemon-install-helpers.js";

afterEach(() => {
  process.argv = [...originalArgv];
  vi.resetAllMocks();
});

describe("buildNodeInstallPlan", () => {
  it("sets OPENCLAW_NODE_HEADERS in environment when headers are provided", async () => {
    const argv1 = path.resolve("/tmp/node_modules/.bin/openclaw");
    const entryPath = path.resolve("/tmp/node_modules/openclaw/dist/entry.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const headers = {
      "CF-Access-Client-Id": "test-id",
      "CF-Access-Client-Secret": "test-secret",
    };
    const plan = await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      headers,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_NODE_HEADERS).toBe(JSON.stringify(headers));
  });

  it("does not set OPENCLAW_NODE_HEADERS when headers are empty", async () => {
    const argv1 = path.resolve("/tmp/node_modules/.bin/openclaw");
    const entryPath = path.resolve("/tmp/node_modules/openclaw/dist/entry.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const plan = await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_NODE_HEADERS).toBeUndefined();
  });
});
