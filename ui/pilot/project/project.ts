const form = document.querySelector<HTMLFormElement>("#pilot-project-form");
const summary = document.querySelector<HTMLElement>("#pilot-project-summary");
const parcelInput = document.querySelector<HTMLInputElement>(
  "[data-testid='pilot-project-parcel-input']",
);
const addressInput = document.querySelector<HTMLInputElement>(
  "[data-testid='pilot-project-address-input']",
);
const scopeInput = document.querySelector<HTMLTextAreaElement>(
  "[data-testid='pilot-project-scope-input']",
);
const jurisdictionInput = document.querySelector<HTMLInputElement>("#pilot-jurisdiction");
const launchButton = document.querySelector<HTMLButtonElement>(
  "[data-testid='pilot-project-launch-chat']",
);

const summaryParcel = document.querySelector<HTMLElement>("#pilot-summary-parcel");
const summaryAddress = document.querySelector<HTMLElement>("#pilot-summary-address");
const summaryScope = document.querySelector<HTMLElement>("#pilot-summary-scope");
const summaryJurisdiction = document.querySelector<HTMLElement>("#pilot-summary-jurisdiction");

function inferJurisdiction(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.includes("austin") && normalized.includes("tx")) {
    return "Austin, Travis County, Texas";
  }
  if (normalized.includes("houston") && normalized.includes("tx")) {
    return "Houston, Harris County, Texas";
  }
  return "Manual review required";
}

function updateSummary() {
  if (
    !parcelInput ||
    !addressInput ||
    !scopeInput ||
    !summary ||
    !summaryParcel ||
    !summaryAddress ||
    !summaryScope ||
    !summaryJurisdiction
  ) {
    return;
  }

  const jurisdiction = inferJurisdiction(addressInput.value);

  summaryParcel.textContent = parcelInput.value.trim();
  summaryAddress.textContent = addressInput.value.trim();
  summaryScope.textContent = scopeInput.value.trim();
  summaryJurisdiction.textContent = jurisdiction;
  summary.hidden = false;

  if (jurisdictionInput) {
    jurisdictionInput.value = jurisdiction;
  }
  if (launchButton) {
    launchButton.disabled = false;
  }
  summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) {
    return;
  }
  updateSummary();
});
