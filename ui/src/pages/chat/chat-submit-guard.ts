import type { ChatHost } from "./chat-send-contract.ts";

const MAX_RECENT_SUBMISSIONS = 256;

function pruneRecentSubmissions(
  submissions: NonNullable<ChatHost["chatSubmissionGuards"]>,
  protectedId: string,
): void {
  if (submissions.size <= MAX_RECENT_SUBMISSIONS) {
    return;
  }
  for (const [id, entry] of submissions) {
    if (submissions.size <= MAX_RECENT_SUBMISSIONS) {
      return;
    }
    if (id !== protectedId && entry.settled) {
      submissions.delete(id);
    }
  }
}

function runAsPromise<T>(run: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("Chat submission failed.", { cause: error }),
    );
  }
}

export function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  const predecessor = guards.get(key);
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  guards.set(key, tail);

  const task = predecessor
    ? predecessor.then(
        () => runAsPromise(run),
        () => runAsPromise(run),
      )
    : runAsPromise(run);
  void task.then(releaseTail, releaseTail);
  void tail.then(() => {
    if (guards.get(key) === tail) {
      guards.delete(key);
    }
  });
  return task;
}

export function withChatSubmissionGuard<T>(
  host: ChatHost,
  submissionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const id = submissionId.trim();
  if (!id) {
    return Promise.reject(new Error("Chat submission id is required."));
  }

  const submissions = (host.chatSubmissionGuards ??= new Map());
  const existing = submissions.get(id);
  if (existing) {
    return existing.promise as Promise<T>;
  }

  let resolveSubmission!: (value: T | PromiseLike<T>) => void;
  let rejectSubmission!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveSubmission = resolve;
    rejectSubmission = reject;
  });
  submissions.set(id, { promise, settled: false });

  const task = runAsPromise(run);
  void task.then(resolveSubmission, rejectSubmission);
  const markSettled = () => {
    const current = submissions.get(id);
    if (current?.promise === promise) {
      submissions.set(id, { promise, settled: true });
      pruneRecentSubmissions(submissions, id);
    }
  };
  void promise.then(markSettled, markSettled);
  return promise;
}
