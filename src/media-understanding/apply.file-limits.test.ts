// Inbound file-extraction limit resolution must track the chat attachment
// accept cap and the agent-level PDF limits (#90098).
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { DEFAULT_CHAT_ATTACHMENT_MAX_MB } from "../media/configured-max-bytes.js";
import { resolveFileLimits } from "./apply.js";

const MB = 1024 * 1024;

describe("resolveFileLimits", () => {
  it("defaults the byte cap to the inbound chat attachment cap, not the 5MB input-file default", () => {
    const limits = resolveFileLimits({});
    expect(limits.maxBytes).toBe(DEFAULT_CHAT_ATTACHMENT_MAX_MB * MB);
  });

  it("defaults the PDF page cap to the agents.defaults.pdfMaxPages default", () => {
    expect(resolveFileLimits({}).pdf.maxPages).toBe(20);
  });

  it("keeps non-limit fresh-install defaults from resolveInputFileLimits", () => {
    // Fresh-install contract: only the byte/page budgets move to the chat
    // attachment cap; everything else keeps the input-file defaults.
    const limits = resolveFileLimits({});
    expect(limits.maxChars).toBeGreaterThan(0);
    expect(limits.allowedMimes).toContain("application/pdf");
    expect(limits.allowUrl).toBe(true);
  });

  it("tracks agents.defaults.mediaMaxMb for the byte cap", () => {
    const cfg: OpenClawConfig = { agents: { defaults: { mediaMaxMb: 50 } } };
    expect(resolveFileLimits(cfg).maxBytes).toBe(50 * MB);
  });

  it("follows a lowered attachment cap instead of blanket-raising extraction", () => {
    // Upgrade contract: extraction tracks what the gateway accepts in both
    // directions, so a tightened mediaMaxMb tightens extraction too.
    const cfg: OpenClawConfig = { agents: { defaults: { mediaMaxMb: 5 } } };
    expect(resolveFileLimits(cfg).maxBytes).toBe(5 * MB);
  });

  it("uses the larger of mediaMaxMb and pdfMaxBytesMb for the byte cap", () => {
    const cfg: OpenClawConfig = { agents: { defaults: { mediaMaxMb: 50, pdfMaxBytesMb: 30 } } };
    expect(resolveFileLimits(cfg).maxBytes).toBe(50 * MB);
  });

  it("lets agents.defaults.pdfMaxBytesMb raise the byte cap above the attachment cap", () => {
    const cfg: OpenClawConfig = { agents: { defaults: { pdfMaxBytesMb: 30 } } };
    expect(resolveFileLimits(cfg).maxBytes).toBe(30 * MB);
  });

  it("does not let agents.defaults.pdfMaxBytesMb lower the cap below the attachment cap", () => {
    // Anything the gateway accepted must stay extractable or the silent
    // marker-only degradation returns for mid-size PDFs.
    const cfg: OpenClawConfig = { agents: { defaults: { pdfMaxBytesMb: 1 } } };
    expect(resolveFileLimits(cfg).maxBytes).toBe(DEFAULT_CHAT_ATTACHMENT_MAX_MB * MB);
  });

  it("routes agents.defaults.pdfMaxPages to the PDF page cap", () => {
    const cfg: OpenClawConfig = { agents: { defaults: { pdfMaxPages: 8 } } };
    expect(resolveFileLimits(cfg).pdf.maxPages).toBe(8);
  });

  it("keeps explicit responses.files config authoritative", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 50, pdfMaxPages: 60 } },
      gateway: {
        http: {
          endpoints: {
            responses: { files: { maxBytes: 3 * MB, pdf: { maxPages: 2 } } },
          },
        },
      },
    };
    const limits = resolveFileLimits(cfg);
    expect(limits.maxBytes).toBe(3 * MB);
    expect(limits.pdf.maxPages).toBe(2);
  });
});
