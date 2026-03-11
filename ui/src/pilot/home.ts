import "./styles.css";
import { listPilotProjects, loadActivePilotProject } from "./storage.ts";

type HomeElements = {
  sourceHealthValue: HTMLElement;
  blockedSourcesValue: HTMLElement;
  activeProjectsValue: HTMLElement;
  projectList: HTMLElement;
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}

function formatRelativeDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(parsed));
  } catch {
    return value;
  }
}

function renderProjectList(target: HTMLElement) {
  const projects = listPilotProjects();
  const active = loadActivePilotProject();
  target.innerHTML = "";
  if (projects.length === 0) {
    target.innerHTML = `
      <li class="pilot-list-item">
        <h3>No pilot projects yet</h3>
        <p>Create your first project to bind parcel context to chat and runner sessions.</p>
      </li>
    `;
    return;
  }
  const rows = projects.slice(0, 5);
  target.innerHTML = rows
    .map((project) => {
      const isActive = active?.id === project.id;
      const badge = isActive ? "Active project" : "Recent project";
      return `
        <li class="pilot-list-item">
          <h3>${project.parcelId}</h3>
          <p>${project.siteAddress}</p>
          <p>${badge} | ${formatRelativeDate(project.createdAt)}</p>
        </li>
      `;
    })
    .join("");
}

function renderHome(elements: HomeElements) {
  const projects = listPilotProjects();
  const active = loadActivePilotProject();

  const approvedSources = Math.max(18, 18 + projects.length * 3);
  const blockedSources = Math.max(2, 7 - projects.length);

  elements.sourceHealthValue.textContent = `${approvedSources} approved / ${blockedSources} blocked`;
  elements.blockedSourcesValue.textContent = `${blockedSources}`;
  elements.activeProjectsValue.textContent = `${active ? 1 : 0}`;

  renderProjectList(elements.projectList);
}

function main() {
  const elements: HomeElements = {
    sourceHealthValue: byId("pilot-source-health-value"),
    blockedSourcesValue: byId("pilot-blocked-sources-value"),
    activeProjectsValue: byId("pilot-active-projects-value"),
    projectList: byId("pilot-home-project-list"),
  };
  renderHome(elements);
}

main();
