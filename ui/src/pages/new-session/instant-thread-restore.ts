import type { ApplicationContext } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";

export type RetainedNewSessionDraft = {
  page: HTMLElement;
  data: NewSessionRouteData;
  synchronizeGateway: () => void;
  release: () => void;
};

export type InstantThreadRestore = {
  draft: RetainedNewSessionDraft;
  owns: () => boolean;
  canDisplay: () => boolean;
  search: string;
};
const restores = new WeakMap<ApplicationContext, InstantThreadRestore>();
const restoredPages = new WeakMap<object, { page: HTMLElement; canDisplay: () => boolean }>();

/** Only the transaction's rollback loader may consume these in-memory draft bytes. */
export function takeInstantThreadRestore(context: ApplicationContext, search: string) {
  const restore = restores.get(context);
  if (!restore || restore.search !== search || !restore.owns()) {
    return undefined;
  }
  restores.delete(context);
  restoredPages.set(restore.draft.data, {
    page: restore.draft.page,
    canDisplay: restore.canDisplay,
  });
  return restore.draft.data;
}

export function forgetInstantThreadPage(data: NewSessionRouteData | undefined, page: HTMLElement) {
  if (data && restoredPages.get(data)?.page === page) {
    restoredPages.delete(data);
  }
}

export function restoredInstantThreadPage(data: unknown) {
  const restored = data && typeof data === "object" ? restoredPages.get(data) : undefined;
  return restored?.canDisplay() ? restored.page : undefined;
}

/** The lazy transaction registers before the router can present cached draft data. */
export function retainInstantThreadRestore(
  context: ApplicationContext,
  restore: InstantThreadRestore,
) {
  restores.set(context, restore);
  return () => {
    if (restores.get(context) === restore) {
      restores.delete(context);
    }
  };
}
