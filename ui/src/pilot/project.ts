import "./styles.css";
import { createPilotProject } from "./storage.ts";

function readFormString(data: FormData, key: string) {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function renderProjectPage() {
  document.body.innerHTML = `
    <main class="pilot-shell">
      <header class="pilot-topbar">
        <div class="pilot-mark">
          <div class="pilot-mark__badge">MB</div>
          <div>
            <p class="pilot-mark__eyebrow">Pilot intake</p>
            <h1 class="pilot-mark__title">New Pilot Project Setup</h1>
          </div>
        </div>
        <div class="pilot-pills">
          <div class="pilot-pill">Parcel-led intake</div>
          <div class="pilot-pill">Jurisdiction inference</div>
          <div class="pilot-pill">Runner reuse</div>
        </div>
      </header>

      <section class="pilot-form-shell">
        <article class="pilot-panel pilot-form-panel">
          <h2 class="pilot-section-title">Scope the discovery run before source retrieval starts.</h2>
          <p class="pilot-section-body">
            Capture the parcel, address, project scope, and inferred jurisdiction in a dedicated pilot
            context. These records persist independently from generic chats so the next due-diligence run
            starts from project state instead of a blank thread.
          </p>

          <form class="pilot-form" data-testid="pilot-project-form">
            <label class="pilot-field">
              <span>Parcel ID</span>
              <input data-testid="pilot-project-parcel-input" name="parcelId" placeholder="17-0821-0010" required />
            </label>

            <label class="pilot-field">
              <span>Address</span>
              <input data-testid="pilot-project-address-input" name="address" placeholder="1200 E 6th St, Austin, TX" required />
            </label>

            <label class="pilot-field">
              <span>Project scope</span>
              <textarea data-testid="pilot-project-scope-input" name="scope" placeholder="Civil entitlement due diligence, entitlement path, utility overlay review" required></textarea>
            </label>

            <div class="pilot-note">
              Create Project & Discover Sources starts a dedicated pilot project record, a parcel record,
              and an inferred jurisdiction record before chat execution begins.
            </div>

            <button class="pilot-button pilot-button--primary" data-testid="pilot-project-create" type="submit">
              Create Project & Discover Sources
            </button>
          </form>
        </article>

        <aside class="pilot-panel pilot-summary-panel">
          <h2 class="pilot-section-title" data-testid="pilot-project-summary-title">Pilot project created</h2>
          <p class="pilot-section-body">
            Your parcel, jurisdiction, and project state will appear here immediately after creation.
          </p>

          <dl class="pilot-created" data-testid="pilot-project-created">
            <div class="pilot-created__metric">
              <dt>Parcel</dt>
              <dd data-testid="pilot-project-parcel-value">Not created yet</dd>
            </div>
            <div class="pilot-created__metric">
              <dt>Inferred jurisdiction</dt>
              <dd data-testid="pilot-project-jurisdiction-value">Waiting for address input</dd>
            </div>
            <div class="pilot-created__metric">
              <dt>Project status</dt>
              <dd data-testid="pilot-project-status-value">Pending</dd>
            </div>
            <div class="pilot-created__metric">
              <dt>Project workspace</dt>
              <dd>
                <a data-testid="pilot-project-launch-chat" href="/chat?session=pilot:pending">Launch project workspace</a>
              </dd>
            </div>
          </dl>
        </aside>
      </section>
    </main>
  `;

  const form = document.querySelector<HTMLFormElement>("[data-testid='pilot-project-form']");
  if (!form) {
    return;
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const parcelId = readFormString(data, "parcelId");
    const address = readFormString(data, "address");
    const scope = readFormString(data, "scope");
    if (!parcelId || !address || !scope) {
      return;
    }
    const { project, jurisdiction } = createPilotProject({ parcelId, address, scope });
    const parcelValue = document.querySelector<HTMLElement>(
      "[data-testid='pilot-project-parcel-value']",
    );
    const jurisdictionValue = document.querySelector<HTMLElement>(
      "[data-testid='pilot-project-jurisdiction-value']",
    );
    const statusValue = document.querySelector<HTMLElement>(
      "[data-testid='pilot-project-status-value']",
    );
    const launchLink = document.querySelector<HTMLAnchorElement>(
      "[data-testid='pilot-project-launch-chat']",
    );
    if (parcelValue) {
      parcelValue.textContent = `${project.parcelId} · ${address}`;
    }
    if (jurisdictionValue) {
      jurisdictionValue.textContent = jurisdiction.name;
    }
    if (statusValue) {
      statusValue.textContent =
        project.status === "blocked" ? "Blocked for source resolution" : "Ready to launch";
    }
    if (launchLink) {
      launchLink.href = `/chat?session=pilot:${project.id}`;
      launchLink.textContent = "Launch project workspace";
    }
  });
}

renderProjectPage();
