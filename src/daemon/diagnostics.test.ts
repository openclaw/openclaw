import { afterEach, describe, expect, it, vi } from "vitest";

const readFile = vi.hoisted(() => vi.fn<(path: string, encoding: string) => Promise<string>>());
const resolveGatewayLogPaths = vi.hoisted(() =>
  vi.fn(() => ({
    stdoutPath: "/tmp/gateway.stdout.log",
    stderrPath: "/tmp/gateway.stderr.log",
  })),
);

vi.mock("node:fs/promises", () => ({
  default: {
    readFile,
  },
}));

vi.mock("./launchd.js", () => ({
  resolveGatewayLogPaths,
}));

import { readLastGatewayErrorLine } from "./diagnostics.js";

describe("readLastGatewayErrorLine", () => {
  afterEach(() => {
    readFile.mockReset();
    resolveGatewayLogPaths.mockClear();
  });

  it("returns the latest curated gateway error match", async () => {
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("stderr")) {
        return "info\nrefusing to bind gateway on 0.0.0.0:18789\n";
      }
      return "";
    });

    await expect(readLastGatewayErrorLine(process.env)).resolves.toBe(
      "refusing to bind gateway on 0.0.0.0:18789",
    );
  });

  it("returns null when logs contain only unrelated noise", async () => {
    readFile.mockImplementation(async (path: string) => {
      if (path.includes("stderr")) {
        return "[tools] web_fetch failed: 404\n";
      }
      return "2026-04-15T12:00:00.000Z hello from local debugging\n";
    });

    await expect(readLastGatewayErrorLine(process.env)).resolves.toBeNull();
  });
});
