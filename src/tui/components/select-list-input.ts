import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Shared input and focus ownership for terminal list pickers. */
export class SelectListInput {
  protected readonly input = new Input();

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  protected updateInput(data: string): boolean {
    const previous = this.input.getValue();
    this.input.handleInput(data);
    return previous !== this.input.getValue();
  }

  protected renderInput(width: number, label: string, style?: (text: string) => string): string {
    const text = this.input.render(Math.max(0, width - visibleWidth(label)))[0] ?? "";
    return truncateToWidth(label + (style ? style(text) : text), width, "");
  }
}
