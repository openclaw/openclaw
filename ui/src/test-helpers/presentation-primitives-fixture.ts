import "../styles.css";
import "../styles/settings.css";
import "./presentation-primitives-fixture.css";

const query = new URLSearchParams(location.search);
export const group = query.get("group") ?? "settings";
document.documentElement.dataset.theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.dir = query.get("direction") === "rtl" ? "rtl" : "ltr";
export const root = document.createElement("main");
root.className = "presentation-fixture";
root.setAttribute("aria-label", "Presentation primitives");
document.body.append(root);

export function recordAction(action: string) {
  const output = document.querySelector<HTMLOutputElement>("#fixture-outcome");
  if (output) output.value = action;
}

export function finishFixture() {
  const output = document.createElement("output");
  output.id = "fixture-outcome";
  output.setAttribute("aria-label", "Last action");
  output.value = "No action";
  document.body.append(output);
  root.dataset.ready = "true";
}
