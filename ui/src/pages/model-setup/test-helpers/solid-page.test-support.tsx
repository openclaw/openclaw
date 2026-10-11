import { createSignal, flush } from "solid-js";
import { afterEach } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ModelSetupController } from "../model-setup-controller.ts";
import { ModelSetupContent, type ModelSetupPageProps } from "../model-setup-page.tsx";

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
  const [revision, setRevision] = createSignal(0);
  let mounted = false;
  let queued = false;
  let dispose: (() => void) | undefined;
  const controller = new ModelSetupController(root, context, () => {
    if (!mounted || queued) {
      return;
    }
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!mounted) {
        return;
      }
      controller.beforeUpdate();
      setRevision((value) => value + 1);
      flush();
      controller.afterUpdate();
    });
  });
  for (const key of [
    "routeData",
    "embedded",
    "agentLabel",
    "credentialChoices",
    "onClose",
  ] as const) {
    Object.defineProperty(root, key, {
      get: () => controller[key],
      set: (value) => {
        Object.assign(controller, { [key]: value });
        controller.requestUpdate();
      },
    });
  }
  Object.defineProperty(root, "updateComplete", { get: () => controller.updateComplete });
  pages.set(root, {
    mount: () => {
      if (mounted) {
        return;
      }
      mounted = true;
      dispose = mountSolid(
        () => <ModelSetupContent controller={controller} revision={revision} />,
        { container: root },
      ).unmount;
      controller.connect();
    },
    unmount: () => {
      if (!mounted) {
        return;
      }
      mounted = false;
      controller.disconnect();
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
