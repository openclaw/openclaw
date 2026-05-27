import type { InteractiveReply, InteractiveReplyBlock } from "../../../interactive/payload.js";

export function reduceInteractiveReply<TState>(
  interactive: InteractiveReply | undefined,
  initialState: TState,
  reduce: (state: TState, block: InteractiveReplyBlock, index: number) => TState,
): TState {
  let state = initialState;
  for (const [index, block] of (interactive?.blocks ?? []).entries()) {
    state = reduce(state, block, index);
  }
  return state;
}
