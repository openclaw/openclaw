import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import type {
  AvatarPickerProps,
  AvatarPickerFooterState as FooterState,
} from "../pages/agents/avatar-picker.tsx";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { AgentCreateDialog } from "./agent-create-dialog.tsx";

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
  AvatarPicker: (props: AvatarPickerProps) => {
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

function mountDialog() {
  const onCancel = vi.fn(),
    onCreate = vi.fn();
  const view = mountSolid(AgentCreateDialog, { context: dialogContext(), onCancel, onCreate });
  document.body.append(view.container);
  const query = <T extends Element = HTMLElement>(selector: string) =>
    view.container.querySelector<T>(selector);
  const name = query<HTMLInputElement>('input[name="name"]')!;
  const create = query<HTMLButtonElement>('button[type="submit"]')!;
  const setName = (value: string) => {
    name.value = value;
    name.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { ...view, query, name, create, setName, onCancel, onCreate };
}

it("requires a display name and submits the selected Blobster identity", () => {
  const { query, name, create, setName, onCreate, onCancel, dispose } = mountDialog();
  expect(query("h2")?.textContent).toBe("Create new agent");
  expect(name.placeholder).toBe("Name your agent");
  expect(query(".agent-create-dialog__ghost .lobster-pet__svg")).not.toBeNull();
  expect(create.disabled).toBe(true);
  setName("  Scout  ");
  flush();
  expect(create.disabled).toBe(false);
  picker.select!(selectedAvatar);
  flush();
  expect(query(".agent-create-dialog__ghost")).toBeNull();
  expect(query(".agent-create-dialog__preview .identity-avatar--agent")).not.toBeNull();
  create.click();

  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: selectedAvatar });
  expect(onCancel).not.toHaveBeenCalled();
  dispose();
});

it("cancels without creating an agent", () => {
  const { query, onCancel, onCreate, dispose } = mountDialog();
  query<HTMLButtonElement>('[data-action="cancel"]')!.click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCreate).not.toHaveBeenCalled();
  dispose();
});

it.each([
  ["too-detailed", "too detailed"],
  ["unusable", "That image can't be used"],
  ["rejected conversion", "Image conversion failed"],
] as const)("retains the draft and recovers from an upload %s", async (failure, error) => {
  const pending = createDeferred<{ ok: false; reason: "too-detailed" | "unusable" }>();
  const retry = createDeferred<{ ok: true; dataUrl: string }>();
  picker.convert
    .mockReset()
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(retry.promise);
  const { query, name, create, setName, onCreate, dispose } = mountDialog();
  setName("Scout");
  picker.select!(selectedAvatar);
  flush();
  const avatar = () => query(".agent-create-dialog__preview .identity-avatar--agent");
  const preview = avatar();
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
    expect(query('[role="alert"]')?.textContent).toContain(error);
    expect(create.disabled).toBe(false);
    expect(query('input[name="name"]')).toBe(name);
    expect(name.value).toBe("Scout");
    expect(avatar()).toBe(preview);
  });

  picker.upload(file);
  flush();
  expect(query('[role="alert"]')).toBeNull();
  expect(create.disabled).toBe(true);
  const uploadedAvatar = "data:image/webp;base64,dXBsb2Fk";
  retry.resolve({ ok: true, dataUrl: uploadedAvatar });
  await waitForSolid(() => {
    expect(query('[role="alert"]')).toBeNull();
    expect(create.disabled).toBe(false);
    expect(query(".agent-create-dialog__ghost")).toBeNull();
  });
  create.click();
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: uploadedAvatar });
  dispose();
});

it("generates first, then saves the named agent with the generated avatar", () => {
  picker.generate.mockClear();
  const { create: action, setName, onCreate, dispose } = mountDialog();
  setName("Sky helper");
  picker.footerChange!({ mode: "generate", canGenerate: true, generated: false });
  flush();

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
  dispose();
});
