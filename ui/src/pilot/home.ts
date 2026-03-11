import "./styles.css";
import { readPilotProjectRecord } from "./storage";

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function renderLastCreatedProject() {
  const stored = readPilotProjectRecord();
  if (!stored) {
    return;
  }
  const container = requireElement<HTMLElement>("#pilot-home-last-project");
  const summary = requireElement<HTMLElement>("#pilot-home-last-project-summary");
  summary.textContent = `${stored.parcelId} · ${stored.inferredJurisdiction} · ${stored.projectScope}`;
  container.hidden = false;
}

function setupNewProjectNavigation() {
  const button = requireElement<HTMLButtonElement>("[data-testid='pilot-home-new-project']");
  button.addEventListener("click", () => {
    window.location.assign("/pilot/project/");
  });
}

renderLastCreatedProject();
setupNewProjectNavigation();
