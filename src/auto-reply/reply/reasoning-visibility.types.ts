export type ReplyReasoningVisibility = {
  retainForQueue: (isAborted: () => boolean) => void;
  releaseDispatch: () => void;
  close: () => void;
};
