import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
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
}));
const selectedAvatar = "data:image/webp;base64,Ym90";
registerEnglishCatalog(registerSettingsEnglish);
// mock-isolation: exercise the dialog's name and selection contract without mounting the avatar generator.
vi.mock("../pages/agents/avatar-picker.tsx", () => ({
  AvatarPicker: (props: {
    onSelect: (avatar: string) => void;
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
