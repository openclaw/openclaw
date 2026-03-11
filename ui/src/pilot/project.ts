import "./styles.css";
import {
  buildPilotContextBlock,
  buildPilotWorkspaceHref,
  createPilotProject,
  type PilotProject,
} from "./storage.ts";

type ProjectElements = {
  form: HTMLFormElement;
  parcelInput: HTMLInputElement;
  addressInput: HTMLInputElement;
  scopeInput: HTMLTextAreaElement;
  error: HTMLElement;
  summary: HTMLElement;
  summaryParcel: HTMLElement;
  summaryAddress: HTMLElement;
  summaryScope: HTMLElement;
  summaryJurisdiction: HTMLElement;
  summarySession: HTMLElement;
  launchChat: HTMLAnchorElement;
  launchRunner: HTMLAnchorElement;
  contextPreview: HTMLElement;
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}

function setSummary(elements: ProjectElements, project: PilotProject) {
  elements.summaryParcel.textContent = project.parcelId;
  elements.summaryAddress.textContent = project.siteAddress;
  elements.summaryScope.textContent = project.scope;
  elements.summaryJurisdiction.textContent = project.inferredJurisdiction;
  elements.summarySession.textContent = project.sessionKey;
  elements.launchChat.href = buildPilotWorkspaceHref(project, "chat");
  elements.launchRunner.href = buildPilotWorkspaceHref(project, "cron");
  elements.contextPreview.textContent = buildPilotContextBlock(project);
  elements.summary.hidden = false;
}

function validateForm(elements: ProjectElements): string | null {
  if (!elements.parcelInput.value.trim()) {
    return "Parcel ID is required.";
  }
  if (!elements.addressInput.value.trim()) {
    return "Site address is required.";
  }
  if (!elements.scopeInput.value.trim()) {
    return "Scope is required.";
  }
  return null;
}

function clearError(elements: ProjectElements) {
  elements.error.textContent = "";
}

function showError(elements: ProjectElements, message: string) {
  elements.error.textContent = message;
}

function registerCreateHandler(elements: ProjectElements) {
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearError(elements);

    const validationError = validateForm(elements);
    if (validationError) {
      showError(elements, validationError);
      return;
    }

    try {
      const project = createPilotProject({
        parcelId: elements.parcelInput.value,
        siteAddress: elements.addressInput.value,
        scope: elements.scopeInput.value,
      });
      setSummary(elements, project);
    } catch (error) {
      showError(elements, error instanceof Error ? error.message : String(error));
      return;
    }

    elements.summary.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function main() {
  const elements: ProjectElements = {
    form: byId("pilot-project-form"),
    parcelInput: byId("pilot-project-parcel"),
    addressInput: byId("pilot-project-address"),
    scopeInput: byId("pilot-project-scope"),
    error: byId("pilot-project-error"),
    summary: byId("pilot-project-summary"),
    summaryParcel: byId("pilot-summary-parcel"),
    summaryAddress: byId("pilot-summary-address"),
    summaryScope: byId("pilot-summary-scope"),
    summaryJurisdiction: byId("pilot-summary-jurisdiction"),
    summarySession: byId("pilot-summary-session"),
    launchChat: byId("pilot-project-launch-chat-link"),
    launchRunner: byId("pilot-project-launch-runner-link"),
    contextPreview: byId("pilot-project-context"),
  };

  registerCreateHandler(elements);
}

main();
