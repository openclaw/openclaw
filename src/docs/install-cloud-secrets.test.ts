// Cloud secret install docs tests validate documented cloud secret setup.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertGatewayAuthNotKnownWeak } from "../gateway/known-weak-gateway-secrets.js";

const INSTALL_DOCS_DIR = path.join(process.cwd(), "docs", "install");
const CLOUD_DOCKER_VM_INSTALL_DOCS = new Set(["gcp.md", "hetzner.md"]);

async function readInstallDocs(): Promise<Array<{ docName: string; markdown: string }>> {
  const entries = await fs.readdir(INSTALL_DOCS_DIR, { withFileTypes: true });
  return await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        docName: entry.name,
        markdown: await fs.readFile(path.join(INSTALL_DOCS_DIR, entry.name), "utf8"),
      })),
  );
}

describe("cloud install docs", () => {
  it("does not publish a copy-paste gateway token placeholder", async () => {
    for (const { docName, markdown } of await readInstallDocs()) {
      for (const match of markdown.matchAll(/^\s*OPENCLAW_GATEWAY_TOKEN=(\S+)\s*$/gm)) {
        expect(
          () =>
            assertGatewayAuthNotKnownWeak({
              mode: "token",
              token: match[1],
              allowTailscale: false,
            }),
          docName,
        ).not.toThrow();
      }
      for (const match of markdown.matchAll(/^\s*OPENCLAW_GATEWAY_PASSWORD=(\S+)\s*$/gm)) {
        expect(
          () =>
            assertGatewayAuthNotKnownWeak({
              mode: "password",
              password: match[1],
              allowTailscale: false,
            }),
          docName,
        ).not.toThrow();
      }
      expect(markdown, docName).not.toMatch(/^ {4}GOG_KEYRING_PASSWORD=change-me-now$/m);
      if (CLOUD_DOCKER_VM_INSTALL_DOCS.has(docName)) {
        expect(markdown, docName).toMatch(/^ {4}OPENCLAW_GATEWAY_TOKEN=[ \t]*\r?$/m);
        expect(markdown, docName).toMatch(/^ {4}GOG_KEYRING_PASSWORD=[ \t]*\r?$/m);
        expect(markdown, docName).toContain("openssl rand -hex 32");
      }
    }
  });
});
