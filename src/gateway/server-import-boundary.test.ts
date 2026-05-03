import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("gateway startup import boundaries", () => {
  it("keeps heavy cron and doctor legacy paths out of the server.impl import graph", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const validation = readSource("src/config/validation.ts");

    expect(serverImpl).not.toContain('from "./server-cron.js"');
    expect(serverImpl).toContain('from "./server-cron-lazy.js"');
    expect(serverImpl).not.toContain('from "./server-methods.js"');
    expect(serverImpl).not.toContain('from "../plugins/hook-runner-global.js"');
    expect(validation).not.toContain("legacy-secretref-env-marker");
    expect(validation).not.toContain("commands/doctor");
  });
});
