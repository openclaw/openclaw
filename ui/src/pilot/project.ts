import "./styles.css";
import {
  inferJurisdictionFromAddress,
  readPilotProjectRecord,
  writePilotProjectRecord,
} from "./storage";

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

const form = requireElement<HTMLFormElement>("#pilot-project-form");
const summaryPanel = requireElement<HTMLElement>("#pilot-project-summary");
const summaryCopy = requireElement<HTMLElement>("#pilot-project-summary-copy");

function getObjectives(activeForm: HTMLFormElement): string[] {
  const values = activeForm.querySelectorAll<HTMLInputElement>("input[name='objective']:checked");
  return Array.from(values, (input) => input.value);
}

function readStringField(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function renderSummary(copy: string) {
  summaryCopy.textContent = copy;
  summaryPanel.hidden = false;
}

function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (!form.reportValidity()) {
    return;
  }

  const formData = new FormData(form);
  const parcelId = readStringField(formData, "parcelId");
  const address = readStringField(formData, "address");
  const projectScope = readStringField(formData, "projectScope");
  const projectType = readStringField(formData, "projectType", "entitlement");
  const inferredJurisdiction = inferJurisdictionFromAddress(address);
  const objectives = getObjectives(form);

  writePilotProjectRecord({
    parcelId,
    address,
    projectScope,
    projectType,
    objectives,
    inferredJurisdiction,
    createdAtIso: new Date().toISOString(),
  });

  renderSummary(
    `${parcelId} is staged for ${inferredJurisdiction}. Workspace objectives: ${
      objectives.length > 0 ? objectives.join(", ") : "none selected"
    }.`,
  );
}

function renderStoredSummary() {
  const stored = readPilotProjectRecord();
  if (!stored) {
    return;
  }
  renderSummary(
    `${stored.parcelId} is staged for ${stored.inferredJurisdiction}. Workspace objectives: ${
      stored.objectives.length > 0 ? stored.objectives.join(", ") : "none selected"
    }.`,
  );
}

form.addEventListener("submit", handleSubmit);
renderStoredSummary();
