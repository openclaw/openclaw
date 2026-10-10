import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

const CLOUD_WORKER_DOCS = [
  "docs/gateway/cloud-workers.md",
  "docs/gateway/config-cloud-workers.md",
] as const;

function cloudWorkerConfigExamples(filePath: string): unknown[] {
  const markdown = fs.readFileSync(path.join(process.cwd(), filePath), "utf8");
  return Array.from(markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/gu))
    .map((match) => match[1] ?? "")
    .filter((source) => /["']?cloudWorkers["']?\s*:/u.test(source))
    .map((source) => JSON5.parse(source));
}

describe("Cloud Workers documentation contract", () => {
  it.each(CLOUD_WORKER_DOCS)("keeps %s config examples schema-valid", (filePath) => {
    const examples = cloudWorkerConfigExamples(filePath);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(OpenClawSchema.safeParse(example).success).toBe(true);
    }
  });
});
