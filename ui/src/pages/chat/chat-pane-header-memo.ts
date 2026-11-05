/** One projection per pane; callers supply the facts consumed by the projection. */
export class ChatPaneHeaderMemo<T> {
  private inputs?: readonly unknown[];
  private value!: T;

  read(inputs: readonly unknown[], project: () => T): T {
    if (
      !this.inputs ||
      inputs.length !== this.inputs.length ||
      inputs.some((input, index) => !Object.is(input, this.inputs![index]))
    ) {
      this.value = project();
      this.inputs = inputs;
    }
    return this.value;
  }
}
