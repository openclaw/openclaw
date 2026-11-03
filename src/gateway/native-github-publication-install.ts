import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  getPluginInstance,
  getPluginInstanceOwner,
  getPluginOriginalValue,
  hasCurrentPluginInstanceAuthority,
  wrapCurrentPluginInstance,
} from "../plugins/plugin-instance-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { getPluginServiceSchedulerBinding } from "../plugins/service-scheduler-binding.js";
import type {
  RepositoryPublicationPublisher,
  RepositoryWorkerIdentity,
  RepositoryPublicationProvider,
} from "./repository-publication-contract.js";
import { readWorkspacePublicationHost } from "./workspace-publication-binding.js";

/** Install only the vendor adapter. Accepted transaction recovery remains Gateway-owned. */
export async function installRepositoryPublicationProvider(
  provider: RepositoryPublicationProvider,
) {
  const scheduler = getPluginServiceSchedulerBinding()?.();
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = resolveGatewayContext?.();
  const publicationHost = context && readWorkspacePublicationHost(context);
  const instance = pluginInstanceInvocation.getStore()?.instance;
  const owner = instance && getPluginInstanceOwner(instance);
  const managedInstance = owner && getPluginInstance(owner.record);
  if (
    !scheduler ||
    !resolveGatewayContext ||
    !publicationHost ||
    !instance ||
    !owner ||
    !managedInstance ||
    managedInstance !== instance ||
    owner.revoked ||
    provider.id !== instance.pluginId ||
    !hasCurrentPluginInstanceAuthority(instance.pluginId)
  ) {
    throw new Error("Repository publication requires its live Gateway plugin service.");
  }
  const signal = AbortSignal.any([
    scheduler.signal,
    instance.lifecycle.signal,
    getGatewayServiceLifetime({ resolveGatewayContext }),
  ]);
  signal.throwIfAborted();
  // These declared factory results retain executable plugin methods. Returned
  // publishers are restored only when reentering their own provider, preserving
  // its private WeakMap key without traversing ordinary caller data graphs.
  const publishers = new WeakMap<object, RepositoryPublicationPublisher>();
  const rememberPublisher = (publisher: RepositoryPublicationPublisher) => {
    signal.throwIfAborted();
    const retained: RepositoryPublicationPublisher = {
      provenance: publisher.provenance,
      author: publisher.author,
      assertCurrent() {
        signal.throwIfAborted();
        publisher.assertCurrent();
      },
      async refresh() {
        signal.throwIfAborted();
        await publisher.refresh();
      },
      async authorizeGit(transfer) {
        signal.throwIfAborted();
        await publisher.authorizeGit(transfer);
      },
    };
    publishers.set(retained, publisher);
    return retained;
  };
  const restorePublisher = (publisher: RepositoryPublicationPublisher) => {
    signal.throwIfAborted();
    let original: object = publisher;
    for (
      let next = getPluginOriginalValue(original, managedInstance);
      next;
      next = getPluginOriginalValue(original, managedInstance)
    ) {
      original = next;
    }
    const retained = publishers.get(original);
    if (!retained) {
      throw new Error("Repository publisher does not belong to this provider.");
    }
    return retained;
  };
  const restoreInput = <T extends { publisher: RepositoryPublicationPublisher }>(input: T): T => ({
    ...input,
    publisher: restorePublisher(input.publisher),
  });
  const resolveGitAuthor = provider.resolveGitAuthor;
  const prepareWorkerIdentity = provider.prepareWorkerIdentity;
  const retainWorkerIdentity = (identity: RepositoryWorkerIdentity): RepositoryWorkerIdentity => ({
    signal: AbortSignal.any([signal, identity.signal]),
    assertCurrent() {
      signal.throwIfAborted();
      identity.assertCurrent();
    },
    async refresh(assertCurrent) {
      signal.throwIfAborted();
      return await identity.refresh(assertCurrent);
    },
    subscribe(listener) {
      signal.throwIfAborted();
      return identity.subscribe(listener);
    },
    async deliver(transfer) {
      signal.throwIfAborted();
      await identity.deliver(transfer);
    },
  });
  const subscribeWorkerIdentityChanges = provider.subscribeWorkerIdentityChanges;
  const adapter: RepositoryPublicationProvider = {
    id: provider.id,
    supportsOrigin(originUrl) {
      signal.throwIfAborted();
      provider.assertCurrent();
      return provider.supportsOrigin(originUrl);
    },
    assertCurrent() {
      signal.throwIfAborted();
      provider.assertCurrent();
    },
    formatReport: (result) => provider.formatReport(result),
    ...(resolveGitAuthor && { resolveGitAuthor }),
    ...(prepareWorkerIdentity && {
      prepareWorkerIdentity: async (input: Parameters<typeof prepareWorkerIdentity>[0]) => {
        signal.throwIfAborted();
        const identity = await prepareWorkerIdentity(input);
        signal.throwIfAborted();
        return identity && retainWorkerIdentity(identity);
      },
    }),
    ...(subscribeWorkerIdentityChanges && { subscribeWorkerIdentityChanges }),
    async preparePublisher(...args) {
      signal.throwIfAborted();
      return rememberPublisher(await provider.preparePublisher(...args));
    },
    async bindPersonal(input) {
      signal.throwIfAborted();
      const binding = await provider.bindPersonal(input);
      signal.throwIfAborted();
      const retained = {
        provenance: binding.provenance,
        generation: binding.generation,
        assertCurrent: () => {
          signal.throwIfAborted();
          binding.assertCurrent();
        },
        prepare: async (assertWorkspace: () => void) => {
          signal.throwIfAborted();
          return rememberPublisher(await binding.prepare(assertWorkspace));
        },
      };
      managedInstance.admitFactory(retained.prepare, ["assertCurrent", "refresh", "authorizeGit"]);
      return retained;
    },
    async readOptionsIdentity(input) {
      signal.throwIfAborted();
      const result = await provider.readOptionsIdentity(input);
      signal.throwIfAborted();
      input.assertCurrent();
      return result;
    },
    async preparePersonalAccountStatus(action) {
      signal.throwIfAborted();
      const prepared = await provider.preparePersonalAccountStatus(action);
      signal.throwIfAborted();
      return {
        status: prepared.status,
        assertCurrent() {
          signal.throwIfAborted();
          prepared.assertCurrent();
        },
      };
    },
    async isPublicationSuperseded(snapshot, readPublished) {
      signal.throwIfAborted();
      const result = await provider.isPublicationSuperseded(snapshot, readPublished);
      signal.throwIfAborted();
      return result;
    },
    readPersonalSelection: (action) => {
      signal.throwIfAborted();
      return provider.readPersonalSelection(action);
    },
    async performPullRequestAction(input) {
      signal.throwIfAborted();
      input.assertCurrent();
      const result = await provider.performPullRequestAction(input);
      signal.throwIfAborted();
      input.assertCurrent();
      return result;
    },
    async inspectPullRequest(input) {
      signal.throwIfAborted();
      const inspected = await provider.inspectPullRequest(input);
      signal.throwIfAborted();
      return {
        result: inspected.result,
        ownPublication: inspected.ownPublication,
        publishedHeadCommit: inspected.publishedHeadCommit,
        assertCurrent() {
          signal.throwIfAborted();
          inspected.assertCurrent();
        },
        assertSource(originUrl: string) {
          signal.throwIfAborted();
          inspected.assertSource(originUrl);
        },
        async verifyWriteAccess() {
          signal.throwIfAborted();
          await inspected.verifyWriteAccess();
        },
      };
    },
    async prepareBoundPublication(input) {
      signal.throwIfAborted();
      const bound = await provider.prepareBoundPublication(restoreInput(input));
      signal.throwIfAborted();
      return {
        observedPublication: bound.observedPublication,
        assertCurrent() {
          signal.throwIfAborted();
          bound.assertCurrent();
        },
        async refresh() {
          signal.throwIfAborted();
          return await bound.refresh();
        },
      };
    },
    prepareTarget: (input) => provider.prepareTarget(restoreInput(input)),
    preparePublishedTarget: (input) => provider.preparePublishedTarget(restoreInput(input)),
    readBase: (input) => provider.readBase(restoreInput(input)),
    observeBranch: (input) => provider.observeBranch(restoreInput(input)),
    findPullRequest: (input) => provider.findPullRequest(restoreInput(input)),
    createPullRequest: (input) => provider.createPullRequest(restoreInput(input)),
    reconcile: (input) => provider.reconcile(restoreInput(input)),
    async formatContent(input) {
      signal.throwIfAborted();
      const content = await provider.formatContent(restoreInput(input));
      signal.throwIfAborted();
      return {
        ...content,
        assertCurrent() {
          signal.throwIfAborted();
          content.assertCurrent();
        },
        pullRequestBody() {
          signal.throwIfAborted();
          return content.pullRequestBody();
        },
      };
    },
    async prepareChangeGuard(input) {
      signal.throwIfAborted();
      const assertChangeAllowed = await provider.prepareChangeGuard(input);
      signal.throwIfAborted();
      return () => {
        signal.throwIfAborted();
        assertChangeAllowed();
      };
    },
    executeRepository: (input) => provider.executeRepository(restoreInput(input)),
    resolveFailure: (error) => provider.resolveFailure(error),
    isDefinitiveFailure: (error) => provider.isDefinitiveFailure(error),
  };
  managedInstance.admitFactory(adapter.preparePersonalAccountStatus, ["assertCurrent"]);
  managedInstance.admitFactory(adapter.inspectPullRequest, [
    "assertCurrent",
    "assertSource",
    "verifyWriteAccess",
  ]);
  managedInstance.admitFactory(adapter.prepareBoundPublication, ["assertCurrent", "refresh"]);
  managedInstance.admitFactory(adapter.preparePublisher, [
    "assertCurrent",
    "refresh",
    "authorizeGit",
  ]);
  managedInstance.admitFactory(adapter.bindPersonal, ["assertCurrent", "prepare"]);
  managedInstance.admitFactory(adapter.formatContent, ["assertCurrent", "pullRequestBody"]);
  if (adapter.prepareWorkerIdentity) {
    managedInstance.admitFactory(adapter.prepareWorkerIdentity, [
      "assertCurrent",
      "refresh",
      "subscribe",
      "deliver",
    ]);
  }
  return await publicationHost.install(wrapCurrentPluginInstance(adapter), signal);
}
