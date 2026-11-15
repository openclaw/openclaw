import { lazyModule } from "solid-js";

/** Loaded presentation code is the pane's readiness fact for inline commands. */
export type InlineCommandPresentation =
  typeof import("./components/chat-inline-command-presentation.tsx");

export type InlineCommandDisclosurePolicy = Pick<
  InlineCommandPresentation,
  "inlineActivityDisclosureCalls"
>;

const presentationModule = lazyModule(
  () => import("./components/chat-inline-command-presentation.tsx"),
);

export async function inlineCommandPresentation(): Promise<InlineCommandPresentation> {
  const presentation = await presentationModule();
  // Prepare the existing row without replacing its identity when the preference changes.
  await presentation.ToolCardBody.preload();
  return presentation;
}
