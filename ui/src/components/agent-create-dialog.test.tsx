import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { AgentCreateDialog } from "./agent-create-dialog.tsx";

type FooterState = {
  mode: "bot" | "generate" | "upload";
  canGenerate: boolean;
  generated: boolean;
  busy: boolean;
};

const picker = vi.hoisted(() => ({
  select: null as ((avatar: string) => void) | null,
  footerChange: null as ((state: Partial<FooterState>) => void) | null,
  generate: vi.fn(),
  upload: vi.fn<(file: File) => void>(),
  convert: vi.fn(),
}));
const selectedAvatar = "data:image/webp;base64,Ym90";
registerEnglishCatalog(registerSettingsEnglish);
// mock-isolation: exercise dialog selection/upload state without mounting the avatar generator.
vi.mock("../pages/agents/avatar-image.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/agents/avatar-image.ts")>()),
  fileToAvatarDataUrl: picker.convert,
}));
// mock-isolation: control picker interactions while keeping the shared result decoder real.
vi.mock("../pages/agents/avatar-picker.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/agents/avatar-picker.tsx")>()),
  AvatarPicker: (props: {
    onSelect: (avatar: string) => void;
    onUpload: (file: File) => void;
    onActionsReady?: (actions: {
      generate: () => Promise<void>;
      reset: () => void;
      footerState: () => FooterState;
    }) => void;
  }) => {
    const [footerState, setFooterState] = createSignal<FooterState>({
      mode: "bot",
      canGenerate: false,
      generated: false,
      busy: false,
    });
    return (
      <div
        data-testid="choose-avatar"
        ref={() => {
          picker.select = props.onSelect;
          picker.upload.mockImplementation(props.onUpload);
          picker.footerChange = (state) =>
            setFooterState((previous) => ({ ...previous, ...state }));
          props.onActionsReady?.({
            generate: async () => picker.generate(),
            reset: () => {},
            footerState,
          });
        }}
      />
    );
  },
}));

afterEach(() => document.body.replaceChildren());

function dialogContext(): ApplicationContext {
  const { gateway } = createApplicationGateway();
  // The picker is mocked; these interactions only read the Gateway and agent roster.
  return { gateway, agents: { state: { agentsList: null } } } as ApplicationContext;
}

it("requires a display name and submits the selected Blobster identity", () => {
  const onCancel = vi.fn();
  const onCreate = vi.fn();
  const view = mountSolid(AgentCreateDialog, { context: dialogContext(), onCancel, onCreate });
  document.body.append(view.container);

  const name = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
  const create = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(view.container.querySelector("h2")?.textContent).toBe("Create new agent");
  expect(name.placeholder).toBe("Name your agent");
  expect(
    view.container.querySelector(".agent-create-dialog__ghost .lobster-pet__svg"),
  ).not.toBeNull();
  expect(create.disabled).toBe(true);
  name.value = "  Scout  ";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(create.disabled).toBe(false);
  picker.select!(selectedAvatar);
  flush();
  expect(view.container.querySelector(".agent-create-dialog__ghost")).toBeNull();
  expect(
    view.container.querySelector(".agent-create-dialog__preview .identity-avatar--agent"),
  ).not.toBeNull();
  create.click();

  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: selectedAvatar });
  expect(onCancel).not.toHaveBeenCalled();
  view.dispose();
});

it("cancels without creating an agent", () => {
  const onCancel = vi.fn();
  const onCreate = vi.fn();
  const view = mountSolid(AgentCreateDialog, { context: dialogContext(), onCancel, onCreate });
  document.body.append(view.container);

  view.container.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();

  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCreate).not.toHaveBeenCalled();
  view.dispose();
});

it.each(["too-detailed", "unusable", "rejected conversion"] as const)(
  "retains the draft and recovers from an upload %s",
  async (failure) => {
    const pending = createDeferred<{ ok: false; reason: "too-detailed" | "unusable" }>();
    const retry = createDeferred<{ ok: true; dataUrl: string }>();
    picker.convert
      .mockReset()
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(retry.promise);
    const onCreate = vi.fn();
    const view = mountSolid(AgentCreateDialog, {
      context: dialogContext(),
      onCancel: vi.fn(),
      onCreate,
    });
    document.body.append(view.container);
    const name = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
    const create = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    name.value = "Scout";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    picker.select!(selectedAvatar);
    flush();
    const preview = view.container.querySelector(
      ".agent-create-dialog__preview .identity-avatar--agent",
    );
    expect(create.disabled).toBe(false);

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    picker.upload(file);
    flush();
    expect(create.disabled).toBe(true);
    create.click();
    expect(onCreate).not.toHaveBeenCalled();
    if (failure === "rejected conversion") {
      pending.reject(new Error("Image conversion failed"));
    } else {
      pending.resolve({ ok: false, reason: failure });
    }
    await waitForSolid(() => {
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        failure === "rejected conversion"
          ? "Image conversion failed"
          : failure === "too-detailed"
            ? "too detailed"
            : "That image can't be used",
      );
      expect(create.disabled).toBe(false);
      expect(view.container.querySelector('input[name="name"]')).toBe(name);
      expect(name.value).toBe("Scout");
      expect(
        view.container.querySelector(".agent-create-dialog__preview .identity-avatar--agent"),
      ).toBe(preview);
    });

    picker.upload(file);
    flush();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(create.disabled).toBe(true);
    const uploadedAvatar = "data:image/webp;base64,dXBsb2Fk";
    retry.resolve({ ok: true, dataUrl: uploadedAvatar });
    await waitForSolid(() => {
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(create.disabled).toBe(false);
      expect(view.container.querySelector(".agent-create-dialog__ghost")).toBeNull();
    });
    create.click();
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: uploadedAvatar });
    view.dispose();
  },
);

it("generates first, then saves the named agent with the generated avatar", () => {
  picker.generate.mockClear();
  const onCreate = vi.fn();
  const view = mountSolid(AgentCreateDialog, {
    context: dialogContext(),
    onCancel: vi.fn(),
    onCreate,
  });
  document.body.append(view.container);
  const name = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
  name.value = "Sky helper";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  picker.footerChange!({ mode: "generate", canGenerate: true, generated: false });
  flush();

  const action = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(action.textContent?.trim()).toBe("Generate");
  picker.footerChange!({ busy: true });
  flush();
  expect(action.disabled).toBe(true);
  picker.footerChange!({ busy: false });
  flush();
  expect(action.disabled).toBe(false);
  action.click();
  expect(picker.generate).toHaveBeenCalledOnce();
  expect(onCreate).not.toHaveBeenCalled();

  picker.select!(selectedAvatar);
  picker.footerChange!({ mode: "generate", canGenerate: true, generated: true });
  flush();
  expect(action.textContent?.trim()).toBe("Save");
  action.click();
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Sky helper", avatar: selectedAvatar });
  view.dispose();
});
