import { MessageFlags } from "discord-api-types/v10";
import { describe, expect, it, beforeEach } from "vitest";
import {
  clearDiscordComponentEntries,
  registerDiscordComponentEntries,
  resolveDiscordComponentEntry,
  resolveDiscordModalEntry,
} from "./components-registry.js";
import {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  readDiscordComponentSpec,
  resolveDiscordComponentAttachmentName,
} from "./components.js";

describe("discord components", () => {
  it("builds v2 containers with modal trigger", () => {
    const spec = readDiscordComponentSpec({
      text: "Choose a path",
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Approve", style: "success" }],
        },
      ],
      modal: {
        title: "Details",
        fields: [{ type: "text", label: "Requester" }],
      },
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }

    const result = buildDiscordComponentMessage({ spec });
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.isV2).toBe(true);
    expect(buildDiscordComponentMessageFlags(result.components)).toBe(MessageFlags.IsComponentsV2);
    expect(result.modals).toHaveLength(1);

    const trigger = result.entries.find((entry) => entry.kind === "modal-trigger");
    expect(trigger?.modalId).toBe(result.modals[0]?.id);
  });

  it("requires options for modal select fields", () => {
    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [{ type: "select", label: "Priority" }],
        },
      }),
    ).toThrow("options");
  });

  it("validates file blocks require attachment:// prefix", () => {
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "https://example.com/image.png" }],
      }),
    ).toThrow("attachment reference");
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "attachment://" }],
      }),
    ).toThrow("filename");
    const spec = readDiscordComponentSpec({
      blocks: [{ type: "file", file: "attachment://myfile.png" }],
    });
    expect(spec?.blocks?.[0]).toMatchObject({ type: "file", file: "attachment://myfile.png" });
  });

  it("validates link buttons require url", () => {
    expect(() =>
      buildDiscordComponentMessage({
        spec: {
          blocks: [{ type: "actions", buttons: [{ label: "Link", style: "link" }] }],
        },
      }),
    ).toThrow("Link buttons require a url");
  });

  it("resolveDiscordComponentAttachmentName extracts filename and rejects invalid refs", () => {
    expect(resolveDiscordComponentAttachmentName("attachment://doc.pdf")).toBe("doc.pdf");
    expect(resolveDiscordComponentAttachmentName("attachment://myfile.png")).toBe("myfile.png");
    expect(() => resolveDiscordComponentAttachmentName("https://example.com/x.png")).toThrow(
      "attachment://",
    );
    expect(() => resolveDiscordComponentAttachmentName("attachment://")).toThrow("filename");
  });
});

describe("discord component registry", () => {
  beforeEach(() => {
    clearDiscordComponentEntries();
  });

  it("registers and consumes component entries", () => {
    registerDiscordComponentEntries({
      entries: [{ id: "btn_1", kind: "button", label: "Confirm" }],
      modals: [
        {
          id: "mdl_1",
          title: "Details",
          fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
        },
      ],
      messageId: "msg_1",
      ttlMs: 1000,
    });

    const entry = resolveDiscordComponentEntry({ id: "btn_1", consume: false });
    expect(entry?.messageId).toBe("msg_1");

    const modal = resolveDiscordModalEntry({ id: "mdl_1", consume: false });
    expect(modal?.messageId).toBe("msg_1");

    const consumed = resolveDiscordComponentEntry({ id: "btn_1" });
    expect(consumed?.id).toBe("btn_1");
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });
});
