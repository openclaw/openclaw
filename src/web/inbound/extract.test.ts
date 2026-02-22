import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { describeReplyContext } from "./extract.js";

describe("describeReplyContext (WhatsApp)", () => {
  it("does not treat LID JIDs as E.164 when reverse mapping is missing", () => {
    // Ensure deterministic behavior even if the dev machine has cached LID reverse mapping files.
    const original = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const target = String(args[0]);
      if (target.includes("lid-mapping-26285350879314_reverse.json")) {
        throw new Error("missing");
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return original(...args);
    });

    try {
      const ctx = describeReplyContext({
        extendedTextMessage: {
          text: "resposta",
          contextInfo: {
            stanzaId: "3EB0A65852648C9DE62727",
            participant: "26285350879314@lid",
            quotedMessage: { conversation: "mensagem original" },
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(ctx?.senderJid).toBe("26285350879314@lid");
      expect(ctx?.senderE164).toBeUndefined();
      expect(ctx?.sender).toBe("26285350879314@lid");
    } finally {
      spy.mockRestore();
    }
  });

  it("extracts E.164 from PN JIDs", () => {
    const ctx = describeReplyContext({
      extendedTextMessage: {
        text: "resposta",
        contextInfo: {
          stanzaId: "3EB0A65852648C9DE62727",
          participant: "14168780149:1@s.whatsapp.net",
          quotedMessage: { conversation: "mensagem original" },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(ctx?.senderJid).toBe("14168780149:1@s.whatsapp.net");
    expect(ctx?.senderE164).toBe("+14168780149");
    expect(ctx?.sender).toBe("+14168780149");
  });
});
