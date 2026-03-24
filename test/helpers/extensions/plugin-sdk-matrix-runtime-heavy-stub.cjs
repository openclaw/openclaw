"use strict";

async function noopAsync() {}
function noop() {}

module.exports = {
  __esModule: true,
  dispatchReplyFromConfigWithSettledDispatcher: noopAsync,
  ensureConfiguredAcpBindingReady: noopAsync,
  maybeCreateMatrixMigrationSnapshot: noop,
  resolveConfiguredAcpBindingRecord: noop,
};
