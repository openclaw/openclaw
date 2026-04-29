export const NODE_SYSTEM_RUN_COMMANDS = [
  "system.run.prepare",
  "system.run",
  "system.which",
] as const;

export const NODE_SYSTEM_NOTIFY_COMMAND = "system.notify";
export const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";

export const NODE_EXEC_APPROVALS_COMMANDS = [
  "system.execApprovals.get",
  "system.execApprovals.set",
] as const;

export const NODE_FILE_FETCH_COMMAND = "file.fetch";
export const NODE_DIR_LIST_COMMAND = "dir.list";
export const NODE_DIR_FETCH_COMMAND = "dir.fetch";
export const NODE_FILE_WRITE_COMMAND = "file.write";
export const NODE_FILE_COMMANDS = [
  NODE_FILE_FETCH_COMMAND,
  NODE_DIR_LIST_COMMAND,
  NODE_DIR_FETCH_COMMAND,
  NODE_FILE_WRITE_COMMAND,
] as const;
