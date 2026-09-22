import { t } from "../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { resolveLobsterPetMode } from "./lobster-pet-contract.ts";
import "./lobster-pet.runtime.ts";

registerNewSessionSetupEnglish();

type LobsterPetMode = ReturnType<typeof resolveLobsterPetMode>;

export type LobsterPetElement = HTMLElement & {
  gatewayVersion: string | null;
  mode: LobsterPetMode;
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  soundsEnabled: boolean;
  updateComplete: Promise<boolean>;
  visitsEnabled: boolean;
};

export function createPet(seed: number, mode: LobsterPetMode = "idle"): LobsterPetElement {
  const element = document.createElement("openclaw-lobster-pet") as LobsterPetElement;
  element.seed = seed;
  element.mode = mode;
  const wrapper = document.createElement("div");
  wrapper.className = "new-session-page__draft";
  wrapper.innerHTML =
    '<div class="agent-chat__input"><textarea></textarea><div class="agent-chat__composer-footer"><div class="agent-chat__composer-lead"></div><div class="chat-composer-model-control"></div><div class="agent-chat__composer-actions"></div></div></div>';
  wrapper.querySelector("textarea")!.setAttribute("aria-label", t("newSession.messagePlaceholder"));
  const boxes: Array<[string, DOMRect]> = [
    [".agent-chat__input", new DOMRect(0, 100, 720, 120)],
    ["textarea", new DOMRect(14, 114, 692, 28)],
    [".agent-chat__composer-footer", new DOMRect(0, 170, 720, 50)],
    [".agent-chat__composer-lead", new DOMRect(8, 175, 130, 32)],
    [".chat-composer-model-control", new DOMRect(480, 175, 132, 32)],
    [".agent-chat__composer-actions", new DOMRect(620, 175, 84, 32)],
  ];
  for (const [selector, box] of boxes) {
    Object.defineProperty(wrapper.querySelector(selector), "getBoundingClientRect", {
      value: () => box,
    });
  }
  wrapper.querySelector(".agent-chat__input")!.prepend(element);
  document.body.append(wrapper);
  return element;
}
