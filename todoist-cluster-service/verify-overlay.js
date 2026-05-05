const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = process.env.HOME || os.homedir();
const TODOIST_DIR = path.join(HOME_DIR, '.openclaw', 'workspace', 'todoist');
const CLUSTERS_DIR = path.join(TODOIST_DIR, 'clusters');
const TASKS_FILE = path.join(TODOIST_DIR, 'tasks.json');
const SUMMARY_FILE = path.join(CLUSTERS_DIR, 'summary.json');
const TASK_INDEX_FILE = path.join(CLUSTERS_DIR, 'task-index.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const tasksPayload = readJson(TASKS_FILE);
  const summary = readJson(SUMMARY_FILE);
  const taskIndex = readJson(TASK_INDEX_FILE);

  assert(Array.isArray(tasksPayload.allTasks), 'tasks.json is missing allTasks');
  assert(Array.isArray(summary.clusters), 'summary.json is missing clusters');
  assert(summary.task_count === tasksPayload.allTasks.length, 'summary task_count does not match tasks.json');
  assert(summary.cluster_count === summary.clusters.length, 'summary cluster_count does not match cluster array');

  const detailCache = {};
  summary.clusters.forEach(function(cluster) {
    const detailFile = path.join(CLUSTERS_DIR, cluster.detail_file);
    assert(fs.existsSync(detailFile), 'Missing detail file for cluster ' + cluster.cluster_id);
    const detail = readJson(detailFile);
    detailCache[cluster.cluster_id] = detail;
    assert(Array.isArray(detail.tasks), 'Cluster detail missing tasks for ' + cluster.cluster_id);
    assert(detail.tasks.length === cluster.task_count, 'Cluster detail task count mismatch for ' + cluster.cluster_id);
  });

  tasksPayload.allTasks.forEach(function(task) {
    const indexEntry = taskIndex[task.id];
    assert(indexEntry, 'Missing task-index entry for ' + task.id);
    const detail = detailCache[indexEntry.cluster_id];
    assert(detail, 'Missing cluster detail for task ' + task.id);
    const matchedTask = detail.tasks.find(function(item) { return item.task_id === task.id; });
    assert(matchedTask, 'Cluster detail does not preserve task ' + task.id);
  });

  const emailTasks = Object.values(taskIndex).filter(function(entry) {
    return entry.thread_lookup_method === 'subject' || entry.thread_lookup_method === 'subject_search_best_effort';
  });
  assert(emailTasks.length > 0, 'Expected at least one email-traceable task');
  emailTasks.forEach(function(entry) {
    assert(entry.subject_hint, 'Email-traceable task missing subject_hint');
    assert(entry.msg_id_is_secondary_only === true, 'msgId must be marked secondary only');
  });

  const multiTaskClusters = summary.clusters.filter(function(cluster) { return cluster.task_count > 1; });
  assert(multiTaskClusters.length > 0, 'Expected at least one real multi-task packet');

  const bestPacket = multiTaskClusters.find(function(cluster) {
    return /assembly studio|jennifer miller studio/i.test(cluster.display_name);
  }) || multiTaskClusters[0];

  const conservativeSingletons = summary.clusters.filter(function(cluster) { return cluster.task_count === 1; });
  assert(conservativeSingletons.length > 0, 'Expected singleton clusters for uncertain cases');

  console.log('verify: ok');
  console.log('tasks:', summary.task_count);
  console.log('clusters:', summary.cluster_count);
  console.log('multi_task_cluster:', bestPacket.cluster_id, bestPacket.display_name, bestPacket.task_count);
  console.log('singletons:', conservativeSingletons.length);
}

main();
