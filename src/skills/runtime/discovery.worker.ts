import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { runSkillsDiscoveryTask } from "./discovery-task.js";
import type { SkillsDiscoveryInput, SkillsDiscoveryOutput } from "./discovery-worker-contract.js";

serveWorkerTasks<SkillsDiscoveryOutput, SkillsDiscoveryInput>(runSkillsDiscoveryTask);
