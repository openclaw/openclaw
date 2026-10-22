import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronScratchGetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createGateway, operatorHello } from "./cron-page.test-support.tsx";
import { CronScratchEditor } from "./scratch-editor.tsx";

type ScratchEditor = HTMLElement;

async function settle() {
  await Promise.resolve();
  flush();
}
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
  const gateway = createGateway(createTestGatewayClient(request), true);
  const [jobId, setJobId] = createSignal("ordinary-job");
  const [currentGateway, setGateway] = createSignal<ApplicationContext["gateway"] | null>(gateway);
  let lifetime = Promise.withResolvers<void>();
  const retire = () => {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  };
  const view = mountSolid(() =>
    CronScratchEditor({
      getRetired: () => lifetime.promise,
      get jobId() {
        return jobId();
      },
      get gateway() {
        return currentGateway();
      },
    }),
  );
  await settle();
  const editor = view.container.querySelector<HTMLElement>("openclaw-cron-scratch-editor")!;
  return {
    editor,
    gateway,
    setJobId(this: void, id: string) {
      retire();
      setJobId(id);
    },
    setGateway(this: void, next: ApplicationContext["gateway"] | null) {
      retire();
      setGateway(next);
    },
    unmount(this: void) {
      retire();
      view.unmount();
    },
  };
}

async function click(editor: ScratchEditor, label: string) {
  const button = getButtonByText(editor, label);
  await waitForSolid(() => expect(button.disabled).toBe(false));
  button.click();
  await settle();
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

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("ordinary automation scratch editor", () => {
  it.each([false, true])("retains a pending save draft after rejected=%s", async (rejected) => {
    const pending = Promise.withResolvers<CronScratchGetResult>();
    onTestFinished(() => pending.resolve(snapshot("Draft notes", 2)));
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValueOnce(snapshot("Saved notes", 1))
      .mockImplementationOnce(() => pending.promise);
    const { editor } = await mount(request);
    await click(editor, "Load scratch");
    const textarea = editor.querySelector("textarea")!;
    textarea.value = "Draft notes";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = getButtonByText(editor, "Save scratch");
    save.click();
    await waitForSolid(() => expect(save.disabled).toBe(true));
    expect(textarea.value).toBe("Draft notes");
    expect(textarea.readOnly).toBe(true);
    if (rejected) {
      pending.reject(new Error("Synthetic save unavailable"));
    } else {
      pending.resolve(snapshot("Draft notes", 2));
    }
    await waitForSolid(() => expect(save.disabled).toBe(false));
    expect(editor.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("Draft notes");
    expect(editor.textContent).toContain(rejected ? "Synthetic save unavailable" : "Scratch saved");
  });

  it("releases a held save when selecting another job", async () => {
    const pending = Promise.withResolvers<CronScratchGetResult>();
    onTestFinished(() => pending.resolve(snapshot("Retired notes", 2)));
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValueOnce(snapshot("Saved notes", 1))
      .mockImplementationOnce(() => pending.promise);
    const { editor, setJobId } = await mount(request);
    await click(editor, "Load scratch");
    const save = getButtonByText(editor, "Save scratch");
    save.click();
    await waitForSolid(() => expect(save.disabled).toBe(true));
    setJobId("another-job");
    await waitForSolid(() => expect(editor.querySelector("textarea")).toBeNull());
    expect(getButtonByText(editor, "Load scratch").disabled).toBe(false);
    pending.reject(new Error("Retired save failed"));
    await pending.promise.catch(() => {});
    await settle();
    expect(editor.textContent).not.toContain("Retired save failed");
  });

  it("loads on demand and admits only one read while it is pending", async () => {
    const pending = createDeferred<CronScratchGetResult>();
    const request = vi.fn(() => pending.promise);
    const { editor } = await mount(request);
    expect(request).not.toHaveBeenCalled();
    const load = getButtonByText(editor, "Load scratch");
    load.click();
    load.click();
    expect(request).toHaveBeenCalledOnce();
    await settle();
    expect(load.disabled).toBe(true);
    pending.resolve(snapshot("Saved notes", 1));
    await pending.promise;
    await settle();
    expect(editor.querySelector("textarea")?.value).toBe("Saved notes");
    await waitForSolid(() => expect(load.disabled).toBe(false));
  });

  it("keeps the draft on a failed reload and allows another read", async () => {
    const reload = createDeferred<CronScratchGetResult>();
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValueOnce(snapshot("Saved notes", 1))
      .mockImplementationOnce(() => reload.promise)
      .mockResolvedValueOnce(snapshot("Updated notes", 2));
    const { editor } = await mount(request);
    await click(editor, "Load scratch");
    const textarea = editor.querySelector("textarea")!;
    textarea.value = "Unsaved draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const button = getButtonByText(editor, "Reload scratch");
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(textarea.value).toBe("Unsaved draft");
    reload.reject(new Error("Synthetic read unavailable"));
    await waitForSolid(() => {
      expect(editor.querySelector('[role="status"]')?.textContent).toBe(
        "Synthetic read unavailable",
      );
      expect(button.disabled).toBe(false);
    });
    expect(editor.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("Unsaved draft");
    button.click();
    await waitForSolid(() => {
      expect(textarea.value).toBe("Updated notes");
      expect(editor.querySelector('[role="status"]')).toBeNull();
    });
  });

  it.each([
    { action: "Save scratch", content: "Unsaved draft", message: "Scratch saved." },
    { action: "Remove scratch", content: null, message: "Scratch removed." },
  ])("retires a failed reload when $action succeeds", async ({ action, content, message }) => {
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValueOnce(snapshot("Saved notes", 1))
      .mockRejectedValueOnce(new Error("Synthetic read unavailable"))
      .mockResolvedValueOnce({ ok: true, ...snapshot(content, 2) });
    const { editor } = await mount(request);
    await click(editor, "Load scratch");
    const textarea = editor.querySelector("textarea")!;
    textarea.value = "Unsaved draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await click(editor, "Reload scratch");
    await waitForSolid(() => {
      expect(editor.textContent).toContain("Synthetic read unavailable");
      expect(getButtonByText(editor, action).disabled).toBe(false);
    });
    expect(textarea.value).toBe("Unsaved draft");
    await click(editor, action);
    await waitForSolid(() => {
      expect(editor.textContent).toContain(message);
      expect(editor.textContent).not.toContain("Synthetic read unavailable");
    });
    expect(editor.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(textarea.value).toBe(content ?? "");
  });

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
    await settle();
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
    await settle();
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

  it.each([
    "job",
    "access",
    "restored access",
    "source",
    "missing source",
    "reconnect",
    "dispose",
  ] as const)("rejects a pending read after its %s owner changes", async (change) => {
    const pending = createDeferred<CronScratchGetResult>();
    const request = vi.fn(() => pending.promise);
    const { editor, gateway, setJobId, setGateway, unmount } = await mount(request);
    await click(editor, "Load scratch");
    expect(request).toHaveBeenCalledOnce();
    if (change === "job") {
      setJobId("another-job");
    } else if (change === "access" || change === "restored access") {
      gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
      if (change === "restored access") {
        gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
      }
    } else if (change === "source") {
      setGateway(createGateway(gateway.snapshot.client!, true));
    } else if (change === "missing source") {
      setGateway(null);
    } else if (change === "reconnect") {
      gateway.emitSnapshot({ phase: "reconnecting" });
      gateway.emitSnapshot({ phase: "connected" });
    } else {
      unmount();
    }
    await settle();
    pending.resolve(snapshot("Private old notes", 1));
    await pending.promise;
    await settle();
    expect(editor.querySelector("textarea")).toBeNull();
    expect(editor.textContent).not.toContain("Private old notes");
    if (change === "access") {
      expect(editor.querySelector("button")).toBeNull();
    }
  });

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
        await settle();
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
