import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronScratchGetResult } from "../../api/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createContext, createGateway, operatorHello } from "./cron-page.test-support.ts";
import "./scratch-editor.ts";

type ScratchEditor = HTMLElement & { jobId: string; updateComplete: Promise<boolean> };
const snapshot = (
  content: string | null,
  currentRevision: number,
  maxBytes = 262_144,
): CronScratchGetResult => ({
  scratch: content === null ? null : { content, revision: currentRevision, updatedAtMs: 1 },
  currentRevision,
  maxBytes,
});

async function mount(request: (method: string, params?: unknown) => Promise<unknown>) {
  const gateway = createGateway({ request } as GatewayBrowserClient, true);
  const host = createApplicationContextProvider(createContext(gateway));
  const editor = document.createElement("openclaw-cron-scratch-editor") as ScratchEditor;
  editor.jobId = "ordinary-job";
  host.append(editor);
  document.body.append(host);
  await editor.updateComplete;
  return { editor, gateway };
}

async function click(editor: ScratchEditor, label: string) {
  getButtonByText(editor, label).click();
  await editor.updateComplete;
}

function getButtonByText(editor: Element, label: string): HTMLButtonElement {
  const button = [...editor.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Missing scratch action: ${label}`);
  }
  return button;
}

afterEach(() => document.body.replaceChildren());

describe("ordinary automation scratch editor", () => {
  it("preserves a conflicting draft until reload and distinguishes empty scratch from removal", async () => {
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValueOnce(snapshot("Original notes", 4))
      .mockResolvedValueOnce({ ok: false, reason: "revision-conflict", currentRevision: 5 })
      .mockResolvedValueOnce(snapshot("Other writer's notes", 5))
      .mockResolvedValueOnce({ ok: true, ...snapshot("", 6) })
      .mockResolvedValueOnce({ ok: true, ...snapshot(null, 7) });
    const { editor } = await mount(request);
    expect(request).not.toHaveBeenCalled();
    await click(editor, "Load scratch");
    const textarea = editor.querySelector("textarea")!;
    textarea.value = "My draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await click(editor, "Save scratch");
    expect(request).toHaveBeenLastCalledWith("cron.scratch.set", {
      id: "ordinary-job",
      content: "My draft",
      expectedRevision: 4,
    });
    expect(textarea.value).toBe("My draft");
    expect(editor.textContent).toContain("Scratch changed during editing");
    expect(getButtonByText(editor, "Save scratch").disabled).toBe(true);
    expect(getButtonByText(editor, "Remove scratch").disabled).toBe(true);

    await click(editor, "Reload scratch");
    expect(textarea.value).toBe("Other writer's notes");
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await click(editor, "Save scratch");
    expect(request).toHaveBeenLastCalledWith("cron.scratch.set", {
      id: "ordinary-job",
      content: "",
      expectedRevision: 5,
    });
    await click(editor, "Remove scratch");
    expect(request).toHaveBeenLastCalledWith("cron.scratch.set", {
      id: "ordinary-job",
      content: null,
      expectedRevision: 6,
    });
    expect(editor.textContent).toContain("No scratch saved.");
  });

  it.each(["job", "access"] as const)(
    "rejects a pending read after its %s owner changes",
    async (change) => {
      const pending = createDeferred<CronScratchGetResult>();
      const request = vi.fn(() => pending.promise);
      const { editor, gateway } = await mount(request);
      await click(editor, "Load scratch");
      expect(request).toHaveBeenCalledOnce();
      if (change === "job") {
        editor.jobId = "another-job";
      } else {
        gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
      }
      await editor.updateComplete;
      pending.resolve(snapshot("Private old notes", 1));
      await pending.promise;
      await editor.updateComplete;
      expect(editor.querySelector("textarea")).toBeNull();
      expect(editor.textContent).not.toContain("Private old notes");
      if (change === "access") {
        expect(editor.querySelector("button")).toBeNull();
      }
    },
  );

  it.each([
    { content: "token=synthetic-private-token", maxBytes: 262_144, redacted: true },
    { content: "notes", maxBytes: 8, redacted: false },
  ])(
    "allows removal while protecting $redacted content from an unsafe overwrite",
    async ({ content, maxBytes, redacted }) => {
      const request = vi
        .fn<GatewayBrowserClient["request"]>()
        .mockResolvedValueOnce(snapshot(content, 2, maxBytes))
        .mockResolvedValueOnce({ ok: true, ...snapshot(null, 3, maxBytes) });
      const { editor } = await mount(request);
      await click(editor, "Load scratch");
      const textarea = editor.querySelector("textarea")!;
      if (redacted) {
        expect(textarea.value).toContain("[redacted]");
        expect(textarea.value).not.toContain("synthetic-private-token");
        expect(textarea.readOnly).toBe(true);
      } else {
        textarea.value = "é".repeat(8);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await editor.updateComplete;
      }
      expect(getButtonByText(editor, "Save scratch").disabled).toBe(true);
      await click(editor, "Remove scratch");
      expect(request).toHaveBeenLastCalledWith("cron.scratch.set", {
        id: "ordinary-job",
        content: null,
        expectedRevision: 2,
      });
      expect(textarea.value).toBe("");
    },
  );
});
