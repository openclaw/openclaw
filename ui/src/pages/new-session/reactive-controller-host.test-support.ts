import type { SolidController, SolidControllerHost } from "../../lit/solid-controller-host.ts";

export class TestReactiveControllerHost implements SolidControllerHost {
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: SolidController) {}
  removeController(_controller: SolidController) {}
  requestUpdate() {}
}
