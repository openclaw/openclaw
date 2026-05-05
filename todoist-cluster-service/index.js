const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildOverlay,
  buildExecutionOverlay,
  defaultOverrides,
  normalizeOverrides,
  writeOverlayFiles
} = require('./clusterer');
const {
  formatWorkBrief,
  resolveClusterMenu,
  resolveWorkPacket
} = require('./work-resolver');

const PORT = Number(process.env.PORT || 3009);
const HOST = process.env.BIND_HOST || process.env.HOST || '127.0.0.1';
const POLL_MS = 1000;
const DEBOUNCE_MS = 400;
const FRESHNESS_CLOCK_SKEW_MS = 1000;
const TASKS_READ_RETRIES = 5;
const TASKS_READ_RETRY_MS = 60;
const LOG_PREFIX = '[todoist-cluster-service]';
const HOME_DIR = process.env.HOME || os.homedir();
const TODOIST_DIR =
  process.env.TODOIST_DIR || process.env.TODOIST_OUTPUT_DIR || path.join(HOME_DIR, '.openclaw', 'workspace', 'todoist');
const TASKS_FILE = process.env.TASKS_FILE || path.join(TODOIST_DIR, 'tasks.json');
const CLUSTERS_DIR = path.join(TODOIST_DIR, 'clusters');
const OVERRIDES_FILE = path.join(CLUSTERS_DIR, 'overrides.json');
const STATUS_FILE = path.join(CLUSTERS_DIR, 'build-status.json');
const TASKBOT_DIR = process.env.TASKBOT_DIR || path.join(HOME_DIR, '.openclaw', 'workspace', 'taskbot');
const EXECUTION_CLUSTERS_DIR = path.join(TASKBOT_DIR, 'execution-clusters');
const TASKBOT_SESSION_FILE = path.join(TASKBOT_DIR, 'session.json');
const TASKBOT_COMPOSE_FILE = path.join(TASKBOT_DIR, 'compose.json');
const TASKBOT_WORK_NEXT_FILE = path.join(TASKBOT_DIR, 'work-next.json');
const TASKBOT_WORK_NEXT_BRIEF_FILE = path.join(TASKBOT_DIR, 'work-next-brief.md');
const TASKBOT_WORK_CLUSTERS_FILE = path.join(TASKBOT_DIR, 'work-clusters.json');

let lastBuildStartedAt = null;
let lastBuildFinishedAt = null;
let lastSourceSyncedAt = null;
let lastError = null;
let isBuilding = false;
let pendingBuild = false;
let debounceTimer = null;

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function isUnexpectedJsonEof(error) {
  return error instanceof SyntaxError && /Unexpected end of JSON input/i.test(error.message);
}

function transientTasksReadError(error, attempts) {
  const wrapped = new Error('tasks.json was mid-write after ' + attempts + ' read attempts: ' + error.message);
  wrapped.code = 'tasks_json_transient_read';
  wrapped.cause = error;
  return wrapped;
}

function readTasksPayload(options) {
  const settings = options || {};
  const retries = Number.isFinite(settings.retries) ? settings.retries : TASKS_READ_RETRIES;
  const retryMs = Number.isFinite(settings.retryMs) ? settings.retryMs : TASKS_READ_RETRY_MS;
  const filePath = settings.filePath || TASKS_FILE;
  const readFile = settings.readFile || function(pathToRead) {
    return fs.readFileSync(pathToRead, 'utf8');
  };
  const wait = settings.wait || sleepSync;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return JSON.parse(readFile(filePath));
    } catch (error) {
      lastError = error;
      if (!isUnexpectedJsonEof(error)) {
        throw error;
      }
      if (attempt < retries) {
        wait(retryMs);
      }
    }
  }

  throw transientTasksReadError(lastError, retries + 1);
}

function ensureOverridesFile() {
  fs.mkdirSync(CLUSTERS_DIR, { recursive: true });
  if (!fs.existsSync(OVERRIDES_FILE)) {
    writeJsonAtomic(OVERRIDES_FILE, defaultOverrides());
  }
}

function ensureTaskbotStateFiles() {
  fs.mkdirSync(TASKBOT_DIR, { recursive: true });
  if (!fs.existsSync(TASKBOT_SESSION_FILE)) {
    writeJsonAtomic(TASKBOT_SESSION_FILE, {
      updated_at: null,
      active_cluster_id: null,
      current_task_id: null,
      current_task_index: null,
      cluster_page: 1,
      mode: 'idle',
      pending_input: 'none',
      completed_task_ids: [],
      skipped_task_ids: [],
      last_opened_cluster_id: null
    });
  }
  if (!fs.existsSync(TASKBOT_COMPOSE_FILE)) {
    writeJsonAtomic(TASKBOT_COMPOSE_FILE, {
      updated_at: null,
      cluster_id: null,
      task_id: null,
      mode: 'none',
      source_instruction: null,
      draft_text: null,
      mailbox: null,
      thread_subject: null,
      message_id: null
    });
  }
}

function readOverrides() {
  ensureOverridesFile();
  try {
    return normalizeOverrides(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')));
  } catch (error) {
    throw new Error('Failed to read overrides.json: ' + error.message);
  }
}

function readTasksMetadata() {
  if (!fs.existsSync(TASKS_FILE)) {
    return {
      exists: false,
      error: 'Missing tasks file: ' + TASKS_FILE
    };
  }

  const stat = fs.statSync(TASKS_FILE);
  const metadata = {
    exists: true,
    mtime_ms: stat.mtimeMs,
    mtime_at: stat.mtime.toISOString(),
    synced_at: null,
    total_tasks: null,
    error: null
  };

  try {
    const payload = readTasksPayload();
    metadata.synced_at = payload.syncedAt || null;
    metadata.total_tasks = Array.isArray(payload.allTasks) ? payload.allTasks.length : null;
    if (payload.error) {
      metadata.error = 'tasks.json contains sync error: ' + payload.error;
    }
  } catch (error) {
    metadata.error = 'Failed to read tasks metadata: ' + error.message;
  }

  return metadata;
}

function freshnessFor(sourceMetadata) {
  const buildFinishedMs = lastBuildFinishedAt ? Date.parse(lastBuildFinishedAt) : null;
  const buildCoversCurrentFile =
    Boolean(buildFinishedMs && sourceMetadata.exists && buildFinishedMs + FRESHNESS_CLOCK_SKEW_MS >= sourceMetadata.mtime_ms);
  const buildCoversCurrentSync =
    !sourceMetadata.synced_at || !lastSourceSyncedAt || sourceMetadata.synced_at === lastSourceSyncedAt;

  return {
    fresh: Boolean(!lastError && !sourceMetadata.error && buildCoversCurrentFile && buildCoversCurrentSync),
    build_covers_current_file: buildCoversCurrentFile,
    build_covers_current_sync: buildCoversCurrentSync
  };
}

function writeStatus(success, extra) {
  const sourceMetadata = readTasksMetadata();
  const freshness = freshnessFor(sourceMetadata);
  writeJsonAtomic(STATUS_FILE, Object.assign({
    success,
    service: 'todoist-clusters',
    updated_at: new Date().toISOString(),
    last_build_started_at: lastBuildStartedAt,
    last_build_finished_at: lastBuildFinishedAt,
    source_tasks_synced_at: lastSourceSyncedAt,
    source_tasks_mtime_ms: sourceMetadata.mtime_ms || null,
    source_tasks_mtime_at: sourceMetadata.mtime_at || null,
    source_tasks_total: sourceMetadata.total_tasks,
    fresh: freshness.fresh,
    build_covers_current_file: freshness.build_covers_current_file,
    build_covers_current_sync: freshness.build_covers_current_sync,
    last_error: lastError
  }, extra || {}));
}

function healthPayload() {
  const sourceMetadata = readTasksMetadata();
  const freshness = freshnessFor(sourceMetadata);
  let status = 'ok';
  if (!lastBuildFinishedAt) {
    status = 'starting';
  } else if (lastError || sourceMetadata.error) {
    status = 'degraded';
  } else if (!freshness.fresh) {
    status = 'stale';
  }

  return {
    status,
    service: 'todoist-clusters',
    last_build_finished_at: lastBuildFinishedAt,
    source_tasks_synced_at: lastSourceSyncedAt,
    source_tasks: sourceMetadata,
    fresh: freshness.fresh,
    build_covers_current_file: freshness.build_covers_current_file,
    build_covers_current_sync: freshness.build_covers_current_sync,
    last_error: lastError
  };
}

function writeResolverSnapshots() {
  try {
    const nextPacket = resolveWorkPacket({
      todoistDir: TODOIST_DIR,
      taskbotDir: TASKBOT_DIR
    });
    writeJsonAtomic(TASKBOT_WORK_CLUSTERS_FILE, resolveClusterMenu({
      todoistDir: TODOIST_DIR,
      taskbotDir: TASKBOT_DIR,
      page: 1,
      pageSize: 5
    }));
    writeJsonAtomic(TASKBOT_WORK_NEXT_FILE, nextPacket);
    fs.writeFileSync(TASKBOT_WORK_NEXT_BRIEF_FILE, formatWorkBrief(nextPacket), 'utf8');
  } catch (error) {
    const payload = {
      ok: false,
      generated_at: new Date().toISOString(),
      error: {
        code: error.code || 'resolver_snapshot_error',
        message: error.message
      }
    };
    writeJsonAtomic(TASKBOT_WORK_NEXT_FILE, payload);
    writeJsonAtomic(TASKBOT_WORK_CLUSTERS_FILE, payload);
    fs.writeFileSync(TASKBOT_WORK_NEXT_BRIEF_FILE, formatWorkBrief(payload), 'utf8');
  }
}

function buildOnce() {
  if (!fs.existsSync(TASKS_FILE)) {
    throw new Error('Missing tasks file: ' + TASKS_FILE);
  }

  lastBuildStartedAt = new Date().toISOString();
  const payload = readTasksPayload();
  const overrides = readOverrides();
  const overlay = buildOverlay(payload, {
    generatedAt: new Date().toISOString(),
    overrides
  });
  const executionOverlay = buildExecutionOverlay(payload, {
    generatedAt: new Date().toISOString()
  });

  writeOverlayFiles(CLUSTERS_DIR, overlay);
  writeOverlayFiles(EXECUTION_CLUSTERS_DIR, executionOverlay);
  ensureTaskbotStateFiles();
  lastSourceSyncedAt = payload.syncedAt || null;
  lastBuildFinishedAt = new Date().toISOString();
  lastError = null;
  writeStatus(true, {
    cluster_count: overlay.summary.cluster_count,
    task_count: overlay.summary.task_count,
    execution_cluster_count: executionOverlay.summary.cluster_count
  });
  writeResolverSnapshots();
  log(
    `generated ${overlay.summary.cluster_count} clusters and ${executionOverlay.summary.cluster_count} execution clusters from ${overlay.summary.task_count} tasks`,
  );
}

function scheduleBuild(reason) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(function() {
    debounceTimer = null;
    runBuild(reason);
  }, DEBOUNCE_MS);
}

function runBuild(reason) {
  if (isBuilding) {
    pendingBuild = true;
    return;
  }

  isBuilding = true;
  pendingBuild = false;
  try {
    if (reason) {
      log('processing ' + reason);
    }
    buildOnce();
  } catch (error) {
    if (error.code === 'tasks_json_transient_read') {
      logError(error.message + '; keeping last successful overlay and retrying');
      scheduleBuild('tasks.json retry after partial read');
      return;
    }
    lastBuildFinishedAt = new Date().toISOString();
    lastError = error.message;
    writeStatus(false);
    logError(error.message);
  } finally {
    isBuilding = false;
    if (pendingBuild) {
      pendingBuild = false;
      runBuild('pending rebuild');
    }
  }
}

function watchFiles() {
  ensureOverridesFile();
  fs.watchFile(TASKS_FILE, { interval: POLL_MS }, function(curr, prev) {
    if (curr.mtimeMs !== prev.mtimeMs) {
      scheduleBuild('tasks.json update');
    }
  });
  fs.watchFile(OVERRIDES_FILE, { interval: POLL_MS }, function(curr, prev) {
    if (curr.mtimeMs !== prev.mtimeMs) {
      scheduleBuild('overrides.json update');
    }
  });
}

function startServer() {
  const server = http.createServer(function(req, res) {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      const payload = healthPayload();
      res.writeHead(payload.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/work/clusters') {
      sendResolverResponse(res, function() {
        return resolveClusterMenu({
          todoistDir: TODOIST_DIR,
          taskbotDir: TASKBOT_DIR,
          page: parsedUrl.searchParams.get('page'),
          pageSize: parsedUrl.searchParams.get('pageSize')
        });
      });
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/work/next') {
      sendResolverResponse(res, function() {
        return resolveWorkPacket({
          todoistDir: TODOIST_DIR,
          taskbotDir: TASKBOT_DIR
        });
      });
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/work/cluster') {
      sendResolverResponse(res, function() {
        return resolveWorkPacket({
          todoistDir: TODOIST_DIR,
          taskbotDir: TASKBOT_DIR,
          clusterId: parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('clusterId')
        });
      });
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/work/task') {
      sendResolverResponse(res, function() {
        return resolveWorkPacket({
          todoistDir: TODOIST_DIR,
          taskbotDir: TASKBOT_DIR,
          taskId: parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('taskId')
        });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, HOST, function() {
    log(`cluster service running on ${HOST}:${PORT}`);
    log(`watching ${TASKS_FILE}`);
    log(`overlay dir ${CLUSTERS_DIR}`);
    log(`health: http://${HOST}:${PORT}/health`);
  });
}

function sendResolverResponse(res, resolvePayload) {
  try {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resolvePayload()));
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: {
        code: error.code || 'resolver_error',
        message: error.message,
        details: error.details || {}
      }
    }));
  }
}

function main() {
  ensureOverridesFile();
  ensureTaskbotStateFiles();
  if (process.argv.includes('--once')) {
    buildOnce();
    return;
  }
  runBuild('startup');
  watchFiles();
  startServer();
}

if (require.main === module) {
  main();
}

module.exports = {
  buildOnce,
  formatWorkBrief,
  healthPayload,
  readTasksMetadata,
  readTasksPayload,
  runBuild,
  writeJsonAtomic,
  writeResolverSnapshots
};
