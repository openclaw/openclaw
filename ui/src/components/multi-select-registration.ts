import type { MultiSelect } from "./multi-select.ts";
import "./multi-select.ts";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-multi-select": MultiSelect;
  }
}
