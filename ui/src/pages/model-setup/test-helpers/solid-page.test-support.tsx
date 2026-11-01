import { createStore, flush } from "solid-js";
import { afterEach } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import type { ModelSetupPageProps } from "../model-setup-owner.ts";
import { ModelSetupPageBody } from "../model-setup-page.tsx";

type MountedPage = { mount: () => void; unmount: () => void };
export type TestModelSetupPage = HTMLElement &
  ModelSetupPageProps & {
    readonly updateComplete: Promise<boolean>;
  };
const pages = new Map<TestModelSetupPage, MountedPage>();

afterEach(() => {
  for (const mounted of pages.values()) {
    mounted.unmount();
  }
  pages.clear();
});

export function createPage(context: ApplicationContext): TestModelSetupPage {
  const root = Object.assign(document.createElement("div"), {
    updateComplete: Promise.resolve(true),
  });
  const [props, setProps] = createStore<ModelSetupPageProps>({});
  let mounted = false;
  let dispose: (() => void) | undefined;
  for (const key of [
    "routeData",
    "embedded",
    "agentLabel",
    "credentialChoices",
    "onClose",
  ] as const) {
    Object.defineProperty(root, key, {
      get: () => props[key],
      set: (value) =>
        setProps((draft) => {
          Object.assign(draft, { [key]: value });
        }),
    });
  }
  Object.defineProperty(root, "updateComplete", {
    get: () =>
      Promise.resolve().then(() => {
        flush();
        return true;
      }),
  });
  pages.set(root, {
    mount: () => {
      if (mounted) {
        return;
      }
      mounted = true;
      dispose = mountSolid(() => <ModelSetupPageBody {...props} host={root} />, {
        container: root,
        wrapper: createSolidApplicationContextProvider(context).wrapper,
      }).unmount;
    },
    unmount: () => {
      if (!mounted) {
        return;
      }
      mounted = false;
      dispose?.();
      dispose = undefined;
    },
  });
  return root;
}

export function mountModelSetupPage(page: TestModelSetupPage): void {
  const mounted = pages.get(page);
  if (!mounted) {
    throw new Error("Page was not created by this harness");
  }
  mounted.mount();
}

export function unmountModelSetupPage(page: TestModelSetupPage): void {
  pages.get(page)?.unmount();
}
