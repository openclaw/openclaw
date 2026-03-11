import "./styles.css";
import { loadPilotSnapshot } from "./storage.ts";

function renderHome() {
  const snapshot = loadPilotSnapshot();
  const validated = snapshot.jurisdictions.filter((entry) => entry.sourceHealth === "validated");
  const revalidation = snapshot.jurisdictions.filter(
    (entry) => entry.sourceHealth === "revalidation",
  );
  const blocked = snapshot.jurisdictions.filter((entry) => entry.sourceHealth === "blocked");

  document.body.innerHTML = `
    <main class="pilot-shell">
      <header class="pilot-topbar">
        <div class="pilot-mark">
          <div class="pilot-mark__badge">MB</div>
          <div>
            <p class="pilot-mark__eyebrow">Construction Knowledge Platform</p>
            <h1 class="pilot-mark__title" data-testid="pilot-home-title">Pilot Home</h1>
          </div>
        </div>
        <div class="pilot-pills">
          <div class="pilot-pill">Discovery-first operating shell</div>
          <div class="pilot-pill">Source-pack readiness</div>
          <div class="pilot-pill">Local pilot runtime</div>
        </div>
      </header>

      <section class="pilot-hero">
        <article class="pilot-panel pilot-panel--hero">
          <div class="pilot-kicker">Validated jurisdictions · blocked source families · active pilot projects</div>
          <h2 class="pilot-hero__title">Operate due diligence from the source-health layer, not a generic chat lobby.</h2>
          <p class="pilot-hero__body">
            This shell keeps the Moore Bass pilot focused on jurisdiction readiness, upcoming reviews,
            and the next parcel-scoped discovery run. It is the launch surface for new project intake
            and the fastest way to see where source retrieval is healthy, drifting, or blocked.
          </p>
          <div class="pilot-actions">
            <a class="pilot-button pilot-button--primary" href="/pilot/project/" data-testid="pilot-home-new-project">New pilot project</a>
            <a class="pilot-button pilot-button--secondary" href="/chat?session=pilot:home">Open pilot chat context</a>
          </div>
        </article>

        <aside class="pilot-panel pilot-panel--summary">
          <div class="pilot-summary-grid">
            <div class="pilot-summary-item">
              <p class="pilot-summary-item__label">Validated coverage</p>
              <p class="pilot-summary-item__value">${validated.length}</p>
            </div>
            <div class="pilot-summary-item">
              <p class="pilot-summary-item__label">Needs revalidation</p>
              <p class="pilot-summary-item__value">${revalidation.length}</p>
            </div>
            <div class="pilot-summary-item">
              <p class="pilot-summary-item__label">Blocked families</p>
              <p class="pilot-summary-item__value">${blocked.length}</p>
            </div>
            <div class="pilot-summary-item">
              <p class="pilot-summary-item__label">Active projects</p>
              <p class="pilot-summary-item__value">${snapshot.projects.length}</p>
            </div>
          </div>
        </aside>
      </section>

      <section class="pilot-grid">
        <article class="pilot-panel pilot-card" data-testid="pilot-dashboard-card-source-health">
          <p class="pilot-card__label">Validated jurisdictions</p>
          <h3 class="pilot-card__title" data-testid="pilot-dashboard-card-source-health-title">Source pack health</h3>
          <p class="pilot-card__body">Jurisdictions with an approved source pack ready for parcel execution.</p>
        </article>
        <article class="pilot-panel pilot-card pilot-card--warn">
          <p class="pilot-card__label">Needs revalidation</p>
          <h3 class="pilot-card__title">${revalidation.length}</h3>
          <p class="pilot-card__body">Coverage drift that should be re-run before new claims are grounded.</p>
        </article>
        <article class="pilot-panel pilot-card pilot-card--danger">
          <p class="pilot-card__label">Blocked source families</p>
          <h3 class="pilot-card__title">${blocked.length}</h3>
          <p class="pilot-card__body">Jurisdictions where zoning, overlays, or permit layers still need an unblocker.</p>
        </article>
        <article class="pilot-panel pilot-card">
          <p class="pilot-card__label">Upcoming reviews</p>
          <h3 class="pilot-card__title">2</h3>
          <p class="pilot-card__body">QAQC and storyboard-fit reviews lined up for current discovery runs.</p>
        </article>
      </section>

      <section class="pilot-lists">
        <article class="pilot-panel pilot-list-panel">
          <h2 class="pilot-list-panel__title">Active pilot projects</h2>
          <p class="pilot-list-panel__body">Parcel-scoped runs stay separate from generic chat sessions and can launch directly back into the runner stack.</p>
          <div class="pilot-project-list">
            ${snapshot.projects
              .map((project) => {
                const jurisdiction = snapshot.jurisdictions.find(
                  (entry) => entry.id === project.jurisdictionId,
                );
                return `
                  <article class="pilot-row">
                    <div class="pilot-row__header">
                      <p class="pilot-row__title">${project.name}</p>
                      <span class="pilot-status pilot-status--${jurisdiction?.sourceHealth ?? "validated"}">${jurisdiction?.name ?? "Unresolved jurisdiction"}</span>
                    </div>
                    <p class="pilot-row__meta">Parcel ${project.parcelId} · ${project.scope}</p>
                    <p class="pilot-row__body"><a href="/chat?session=pilot:${project.id}">Launch project workspace</a></p>
                  </article>
                `;
              })
              .join("")}
          </div>
        </article>

        <article class="pilot-panel pilot-list-panel">
          <h2 class="pilot-list-panel__title">Jurisdiction readiness</h2>
          <p class="pilot-list-panel__body">The operator view should foreground what is grounded, drifting, or blocked before parcel work begins.</p>
          <div class="pilot-jurisdiction-list">
            ${snapshot.jurisdictions
              .map(
                (entry) => `
                <article class="pilot-row">
                  <div class="pilot-row__header">
                    <p class="pilot-row__title">${entry.name}</p>
                    <span class="pilot-status pilot-status--${entry.sourceHealth}">${entry.sourceHealth}</span>
                  </div>
                  <p class="pilot-row__body">${entry.blockedFamily ? `Blocked on ${entry.blockedFamily}` : "Approved source pack is ready for discovery-first parcel work."}</p>
                </article>
              `,
              )
              .join("")}
          </div>
        </article>
      </section>
    </main>
  `;
}

renderHome();
