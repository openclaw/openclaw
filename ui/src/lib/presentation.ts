export const PRESENTATION_CHANGED_EVENT = "openclaw:presentation-changed";

export type PresentationBinding = {
  owner: EventTarget;
  isPresented: () => boolean;
  /** Visual navigation previews can activate warmed content before the parent commits. */
  preview?: () => boolean;
};

export type PresentationValue = boolean | PresentationBinding;
