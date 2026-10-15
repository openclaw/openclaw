import { solidContent } from "../lit/solid-content.tsx";
import { SensitiveInput, type SensitiveInputProps } from "./sensitive-input.tsx";

export function renderSensitiveInput(props: SensitiveInputProps) {
  return solidContent(SensitiveInput, props);
}
