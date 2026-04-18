import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const INSTALL_DOCS_DIR = path.join(process.cwd(), "docs", "install");
const CLOUD_INSTALL_DOCS = ["gcp.md", "hetzner.md"] as const;

describe("cloud install docs", () => {
  it("does not publish a copy-paste gateway token placeholder", async () => {
    for (const docName of CLOUD_INSTALL_DOCS) {
      const markdown = await fs.readFile(path.join(INSTALL_DOCS_DIR, docName), "utf8");

      expect(markdown).not.toContain("OPENCLAW_GATEWAY_TOKEN=change-me-now");
      expect(markdown).toMatch(/OPENCLAW_GATEWAY_TOKEN=[ \t]*\r?\n/);
      expect(markdown).toContain("openssl rand -hex 32");
    }
  });
});
