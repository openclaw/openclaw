var express = require('express');
var fs = require('fs');
var path = require('path');
var app = express();
var PORT = process.env.PORT || 3002;

var TODOIST_API_KEY = process.env.TODOIST_API_KEY;
var OUTPUT_DIR = process.env.TODOIST_OUTPUT_DIR || '/todoist-output';
var BASE_URL = 'https://api.todoist.com/api/v1';
var SYNC_URL = 'https://api.todoist.com/api/v1/sync';
var COMPLETED_ARCHIVE_FILE = 'completed-archive.json';

// --- API helpers ---

async function todoistGet(endpoint) {
  var response = await fetch(BASE_URL + endpoint, {
    headers: { 'Authorization': 'Bearer ' + TODOIST_API_KEY }
  });
  if (!response.ok) {
    throw new Error('Todoist GET ' + endpoint + ': ' + response.status + ' ' + (await response.text()));
  }
  return response.json();
}

// Get all results from a paginated endpoint
async function todoistGetAll(endpoint) {
  var allResults = [];
  var cursor = null;
  var sep = endpoint.indexOf('?') === -1 ? '?' : '&';

  do {
    var url = endpoint + (cursor ? sep + 'cursor=' + cursor : '');
    var data = await todoistGet(url);

    // New API returns { results: [...], next_cursor: "..." }
    if (data.results && Array.isArray(data.results)) {
      allResults = allResults.concat(data.results);
      cursor = data.next_cursor || null;
    } else if (Array.isArray(data)) {
      // Fallback for endpoints that still return arrays
      allResults = data;
      cursor = null;
    } else {
      // Single object response
      allResults = [data];
      cursor = null;
    }
  } while (cursor);

  return allResults;
}

async function todoistGetCompletedByCompletionDate(params) {
  var since = params && params.since;
  var until = params && params.until;
  if (!since || !until) {
    throw new Error('since and until are required for completed archive fetch');
  }

  var limit = Math.max(1, Math.min(Number(params.limit || 200), 200));
  var allItems = [];
  var cursor = null;

  do {
    var query = new URLSearchParams({
      since: since,
      until: until,
      limit: String(limit)
    });
    if (cursor) query.set('cursor', cursor);
    if (params.project_id) query.set('project_id', params.project_id);
    if (params.section_id) query.set('section_id', params.section_id);
    if (params.parent_id) query.set('parent_id', params.parent_id);
    if (params.filter_query) query.set('filter_query', params.filter_query);
    if (params.filter_lang) query.set('filter_lang', params.filter_lang);

    var data = await todoistGet('/tasks/completed/by_completion_date?' + query.toString());
    allItems = allItems.concat(Array.isArray(data.items) ? data.items : []);
    cursor = data.next_cursor || null;
  } while (cursor);

  return allItems;
}

function formatCompletedArchiveItem(t) {
  return {
    id: t.id,
    content: t.content,
    description: t.description || '',
    project_id: t.project_id || null,
    section_id: t.section_id || null,
    parent_id: t.parent_id || null,
    due: t.due || null,
    priority: t.priority,
    labels: t.labels || [],
    created_at: t.created_at || t.added_at || null,
    completed_at: t.completed_at || t.completed_date || t.date_completed || null,
    url: t.url || null
  };
}

async function writeCompletedArchiveSnapshot(params) {
  var items = await todoistGetCompletedByCompletionDate(params || {});
  var formattedItems = items.map(formatCompletedArchiveItem);
  var output = {
    syncedAt: new Date().toISOString(),
    source: 'Todoist /api/v1/tasks/completed/by_completion_date',
    readOnly: true,
    since: params.since,
    until: params.until,
    totalTasks: formattedItems.length,
    allTasks: formattedItems
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, COMPLETED_ARCHIVE_FILE),
    JSON.stringify(output, null, 2)
  );

  return output;
}

async function todoistPost(endpoint, body) {
  var response = await fetch(BASE_URL + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TODOIST_API_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    throw new Error('Todoist POST ' + endpoint + ': ' + response.status + ' ' + (await response.text()));
  }
  if (response.status === 204) return { success: true };
  return response.json();
}

async function todoistDelete(endpoint) {
  var response = await fetch(BASE_URL + endpoint, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + TODOIST_API_KEY }
  });
  if (!response.ok) {
    throw new Error('Todoist DELETE ' + endpoint + ': ' + response.status + ' ' + (await response.text()));
  }
  return { success: true };
}

// Move requires Todoist Sync API — REST API does not support project_id updates
async function todoistSyncMove(taskId, projectId) {
  var uuid = 'move-' + taskId + '-' + Date.now();
  var response = await fetch(SYNC_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TODOIST_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      commands: [
        {
          type: 'item_move',
          uuid: uuid,
          args: {
            id: taskId,
            project_id: projectId
          }
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error('Todoist Sync move: ' + response.status + ' ' + (await response.text()));
  }
  var data = await response.json();
  if (data.sync_status && data.sync_status[uuid] && data.sync_status[uuid] !== 'ok') {
    throw new Error('Todoist Sync move failed: ' + JSON.stringify(data.sync_status[uuid]));
  }
  return { success: true };
}

// --- Sync tasks and projects to files ---

async function syncTasks() {
  try {
    var tasks = await todoistGetAll('/tasks');
    var projects = await todoistGetAll('/projects');
    var labels = await todoistGetAll('/labels');

    var formattedTasks = tasks.map(function(t) {
      return {
        id: t.id,
        content: t.content,
        description: t.description || '',
        project_id: t.project_id,
        project_name: (projects.find(function(p) { return p.id === t.project_id; }) || {}).name || 'Unknown',
        due: t.due ? {
          date: t.due.date,
          string: t.due.string,
          recurring: t.due.is_recurring
        } : null,
        priority: t.priority,
        labels: t.labels || [],
        parent_id: t.parent_id || null,
        order: t.order,
        created_at: t.created_at
      };
    });

    // Group by project for easier reading
    var byProject = {};
    formattedTasks.forEach(function(t) {
      if (!byProject[t.project_name]) {
        byProject[t.project_name] = [];
      }
      byProject[t.project_name].push(t);
    });

    var output = {
      syncedAt: new Date().toISOString(),
      totalTasks: formattedTasks.length,
      byProject: byProject,
      allTasks: formattedTasks
    };

    var projectOutput = {
      syncedAt: new Date().toISOString(),
      projects: projects.map(function(p) {
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          order: p.order,
          is_favorite: p.is_favorite
        };
      }),
      labels: labels.map(function(l) {
        return {
          id: l.id,
          name: l.name,
          color: l.color,
          order: l.order,
          is_favorite: l.is_favorite
        };
      })
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'tasks.json'),
      JSON.stringify(output, null, 2)
    );
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'projects.json'),
      JSON.stringify(projectOutput, null, 2)
    );

    console.log('[todoist] synced ' + formattedTasks.length + ' tasks across ' + projects.length + ' projects');
  } catch (err) {
    console.error('[todoist] sync error:', err.message);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'tasks.json'),
      JSON.stringify({ error: err.message, syncedAt: new Date().toISOString() }, null, 2)
    );
  }
}

// --- Process commands from bot ---

async function processCommand(cmd) {
  var result = { action: cmd.action, success: false, timestamp: new Date().toISOString() };

  try {
    switch (cmd.action) {

      case 'complete':
        if (!cmd.task_id) throw new Error('task_id required');
        await todoistPost('/tasks/' + cmd.task_id + '/close');
        result.success = true;
        result.message = 'Task completed';
        break;

      case 'reopen':
        if (!cmd.task_id) throw new Error('task_id required');
        await todoistPost('/tasks/' + cmd.task_id + '/reopen');
        result.success = true;
        result.message = 'Task reopened';
        break;

      case 'create':
        if (!cmd.content) throw new Error('content required');
        var createBody = { content: cmd.content };
        if (cmd.description) createBody.description = cmd.description;
        if (cmd.project_id) createBody.project_id = cmd.project_id;
        if (cmd.due_string) createBody.due_string = cmd.due_string;
        if (cmd.due_date) createBody.due_date = cmd.due_date;
        if (cmd.priority) createBody.priority = cmd.priority;
        if (cmd.labels) createBody.labels = cmd.labels;
        if (cmd.parent_id) createBody.parent_id = cmd.parent_id;
        var created = await todoistPost('/tasks', createBody);
        result.success = true;
        result.message = 'Task created';
        result.task = { id: created.id, content: created.content };
        break;

      case 'update':
        if (!cmd.task_id) throw new Error('task_id required');
        var updateBody = {};
        if (cmd.content) updateBody.content = cmd.content;
        if (cmd.description !== undefined) updateBody.description = cmd.description;
        if (cmd.due_string) updateBody.due_string = cmd.due_string;
        if (cmd.due_date) updateBody.due_date = cmd.due_date;
        if (cmd.priority) updateBody.priority = cmd.priority;
        if (cmd.labels) updateBody.labels = cmd.labels;
        await todoistPost('/tasks/' + cmd.task_id, updateBody);
        result.success = true;
        result.message = 'Task updated';
        break;

      case 'delete':
        if (!cmd.task_id) throw new Error('task_id required');
        await todoistDelete('/tasks/' + cmd.task_id);
        result.success = true;
        result.message = 'Task deleted';
        break;

      case 'move':
        if (!cmd.task_id || !cmd.project_id) throw new Error('task_id and project_id required');
        await todoistSyncMove(cmd.task_id, cmd.project_id);
        result.success = true;
        result.message = 'Task moved to project ' + cmd.project_id;
        break;

      case 'fetch_completed_archive':
        var archive = await writeCompletedArchiveSnapshot(cmd);
        result.success = true;
        result.message = 'Fetched read-only completed task archive snapshot';
        result.path = path.join(OUTPUT_DIR, COMPLETED_ARCHIVE_FILE);
        result.totalTasks = archive.totalTasks;
        result.since = archive.since;
        result.until = archive.until;
        break;

      default:
        result.message = 'Unknown action: ' + cmd.action + '. Valid actions: complete, reopen, create, update, delete, move, fetch_completed_archive';
    }
  } catch (err) {
    result.message = err.message;
  }

  return result;
}

// --- File watchers ---

function watchForTrigger() {
  var triggerFile = path.join(OUTPUT_DIR, 'trigger.txt');
  setInterval(function() {
    if (fs.existsSync(triggerFile)) {
      console.log('[todoist] trigger detected, syncing...');
      fs.unlinkSync(triggerFile);
      syncTasks();
    }
  }, 2000);
}

function watchForCommands() {
  var commandFile = path.join(OUTPUT_DIR, 'command.json');
  setInterval(async function() {
    if (fs.existsSync(commandFile)) {
      try {
        var raw = fs.readFileSync(commandFile, 'utf8');
        fs.unlinkSync(commandFile);
        var cmd = JSON.parse(raw);

        console.log('[todoist] command received: ' + cmd.action);
        var result = await processCommand(cmd);

        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'command-result.json'),
          JSON.stringify(result, null, 2)
        );

        // Re-sync after any write command. Completed archive fetches are read-only snapshots.
        if (['complete', 'reopen', 'create', 'update', 'delete', 'move'].indexOf(cmd.action) !== -1 && result.success) {
          await syncTasks();
        }

        console.log('[todoist] command result: ' + result.message);
      } catch (err) {
        console.error('[todoist] command error:', err.message);
        fs.writeFileSync(
          path.join(OUTPUT_DIR, 'command-result.json'),
          JSON.stringify({ success: false, message: err.message, timestamp: new Date().toISOString() }, null, 2)
        );
      }
    }
  }, 2000);
}

// --- HTTP endpoints for testing ---

app.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'todoist' });
});

app.get('/sync', async function(req, res) {
  await syncTasks();
  res.json({ status: 'synced' });
});

app.get('/completed-archive', async function(req, res) {
  try {
    var archive = await writeCompletedArchiveSnapshot(req.query || {});
    res.json({ status: 'synced', totalTasks: archive.totalTasks, path: path.join(OUTPUT_DIR, COMPLETED_ARCHIVE_FILE) });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

// --- Start ---

if (!TODOIST_API_KEY) {
  console.error('Missing required env var: TODOIST_API_KEY');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', function() {
  console.log('[todoist] listening on port ' + PORT);
  console.log('[todoist] output dir: ' + OUTPUT_DIR);

  // Initial sync
  syncTasks();

  // Sync every 5 minutes
  setInterval(syncTasks, 5 * 60 * 1000);

  // Watch for bot requests
  watchForTrigger();
  watchForCommands();
});
