import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { RunnerTask } from "vitest";
import {
  experimental_getRunnerTask,
  ReportersMap,
  type Reporter,
  type TestCase,
  type TestModule,
  type TestSuite,
  type Vitest,
} from "vitest/node";
import { redactCredentialText, redactDiagnostic } from "./credential-redaction.ts";

type ReporterReference = Reporter | [string, Record<string, unknown>];
type ReportedEntity = TestCase | TestModule | TestSuite;

function scrubTask(task: RunnerTask) {
  task.name = redactCredentialText(task.name);
  redactDiagnostic(task.result);
  redactDiagnostic(task.meta);
  if (task.type === "test") {
    redactDiagnostic(task.annotations);
  } else {
    for (const child of task.tasks) {
      scrubTask(child);
    }
  }
}

function scrubEntity(entity: ReportedEntity) {
  scrubTask(experimental_getRunnerTask(entity));
}

const scrubbers: Reporter = {
  onTestRunEnd(modules, errors) {
    modules.forEach(scrubEntity);
    redactDiagnostic(errors);
  },
  onTestModuleQueued: scrubEntity,
  onTestModuleCollected: scrubEntity,
  onTestModuleStart: scrubEntity,
  onTestModuleEnd: scrubEntity,
  onTestCaseReady: scrubEntity,
  onTestCaseResult: scrubEntity,
  onTestSuiteReady: scrubEntity,
  onTestSuiteResult: scrubEntity,
  onTestCaseAnnotate(entity, annotation) {
    scrubEntity(entity);
    redactDiagnostic(annotation);
  },
  onWatcherStart(files, errors) {
    files?.forEach(scrubTask);
    redactDiagnostic(errors);
  },
};

function isBuiltinReporter(name: string): name is keyof typeof ReportersMap {
  return Object.hasOwn(ReportersMap, name);
}

type WorkflowValue = "property" | "data";

function decodeWorkflowValue(value: string, kind: WorkflowValue): string {
  return value.replace(/%25|%0D|%0A|%3A|%2C/gu, (encoded) => {
    switch (encoded) {
      case "%25":
        return "%";
      case "%0D":
        return "\r";
      case "%0A":
        return "\n";
      case "%3A":
        return kind === "property" ? ":" : encoded;
      case "%2C":
        return kind === "property" ? "," : encoded;
      default:
        return encoded;
    }
  });
}

function encodeWorkflowValue(value: string, kind: WorkflowValue): string {
  const encoded = value.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
  return kind === "property" ? encoded.replace(/:/gu, "%3A").replace(/,/gu, "%2C") : encoded;
}

function redactLogText(text: string): string {
  let output = "";
  let consumed = 0;
  // Scrub decoded annotation fields independently so values cannot consume wire delimiters.
  for (const match of text.matchAll(/^[\t ]*::(?:error|warning|notice)(?=[\t ]|::)[^\r\n]*/gmu)) {
    const line = match[0];
    const command = line.indexOf("::");
    const separator = line.indexOf("::", command + 2);
    if (separator < 0) {
      continue;
    }
    let header = line.slice(0, separator);
    const relativeProperties = header.slice(command + 2).search(/[\t ]/u);
    if (relativeProperties >= 0) {
      const properties = command + 2 + relativeProperties;
      header =
        header.slice(0, properties) +
        header
          .slice(properties)
          .split(",")
          .map((property) => {
            const equals = property.indexOf("=");
            if (equals < 0) {
              return redactCredentialText(property);
            }
            const prefix = property.slice(0, equals + 1);
            const decoded = decodeWorkflowValue(property.slice(equals + 1), "property");
            const clean = redactCredentialText(prefix + decoded).slice(prefix.length);
            return prefix + encodeWorkflowValue(clean, "property");
          })
          .join(",");
    }
    const data = decodeWorkflowValue(line.slice(separator + 2), "data");
    output += redactCredentialText(text.slice(consumed, match.index));
    output += `${header}::${encodeWorkflowValue(redactCredentialText(data), "data")}`;
    consumed = match.index + line.length;
  }
  return output + redactCredentialText(text.slice(consumed));
}

export default class RedactingReporter implements Reporter {
  private reporters: object[] = [];
  private readonly consoleCapture = new AsyncLocalStorage<boolean>();
  private readonly references: ReporterReference[];
  private initialization = Promise.resolve<{ error?: Error }>({});

  onBrowserInit = this.hook("onBrowserInit");
  onTestRemoved = this.hook("onTestRemoved");
  onWatcherStart = this.hook("onWatcherStart");
  onWatcherRerun = this.hook("onWatcherRerun");
  onServerRestart = this.hook("onServerRestart");
  onUserConsoleLog = this.hook("onUserConsoleLog");
  onProcessTimeout = this.hook("onProcessTimeout");
  onTestRunStart = this.hook("onTestRunStart");
  onTestRunEnd = this.hook("onTestRunEnd");
  onTestModuleQueued = this.hook("onTestModuleQueued");
  onTestModuleCollected = this.hook("onTestModuleCollected");
  onTestModuleStart = this.hook("onTestModuleStart");
  onTestModuleEnd = this.hook("onTestModuleEnd");
  onTestCaseReady = this.hook("onTestCaseReady");
  onTestCaseResult = this.hook("onTestCaseResult");
  onTestCaseAnnotate = this.hook("onTestCaseAnnotate");
  onTestCaseArtifactRecord = this.hook("onTestCaseArtifactRecord");
  onTestSuiteReady = this.hook("onTestSuiteReady");
  onTestSuiteResult = this.hook("onTestSuiteResult");
  onHookStart = this.hook("onHookStart");
  onHookEnd = this.hook("onHookEnd");
  onCoverage = this.hook("onCoverage");
  onTestCaseBenchmark = this.hook("onTestCaseBenchmark");

  constructor(options: { reporters: ReporterReference[] }) {
    this.references = options.reporters;
  }

  onFinishedReportCoverage(...args: unknown[]) {
    return this.forward("onFinishedReportCoverage", args);
  }

  private hook<K extends keyof Reporter>(name: K) {
    return (...args: Parameters<NonNullable<Reporter[K]>>) => this.forward(name, args);
  }

  onInit(ctx: Vitest): void {
    // onInit is synchronous in Vitest's interface; every later hook joins loading.
    this.initialization = this.initialize(ctx).then(
      () => ({}),
      (cause: unknown) => {
        const error =
          cause instanceof Error ? cause : new Error("Reporter initialization failed", { cause });
        redactDiagnostic(error);
        return { error };
      },
    );
  }

  private async initialize(ctx: Vitest) {
    const consoleCapture = this.consoleCapture;
    const logger = new Proxy(ctx.logger, {
      get(target, key, receiver) {
        const method: unknown = Reflect.get(target, key, receiver);
        if (typeof method !== "function") {
          return method;
        }
        if (key === "log" || key === "error" || key === "warn") {
          return (...args: unknown[]) =>
            Reflect.apply(
              method,
              target,
              consoleCapture.getStore() ? args : [redactLogText(format(...args))],
            );
        }
        if (key === "formatError") {
          return (...args: unknown[]) => redactDiagnostic(Reflect.apply(method, target, args));
        }
        // printError generates source excerpts through this logger too.
        return method.bind(receiver);
      },
    });
    const config = new Proxy(ctx.config, {
      get: (target, key) => (key === "reporters" ? this.references : Reflect.get(target, key)),
    });
    const context = new Proxy(ctx, {
      get(target, key) {
        if (key === "logger") {
          return logger;
        }
        if (key === "config") {
          return config;
        }
        const member: unknown = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    for (const reference of this.references) {
      let reporter: object;
      if (!Array.isArray(reference)) {
        reporter = reference;
      } else {
        const [name, options] = reference;
        if (isBuiltinReporter(name)) {
          const Constructor = ReportersMap[name];
          reporter = new Constructor(options);
        } else {
          const module = await ctx.vite.ssrLoadModule(
            name === "html" ? "@vitest/ui/reporter" : name,
          );
          const Constructor: unknown = module.default;
          if (typeof Constructor !== "function") {
            throw new TypeError(`Custom reporter ${name} must export a default constructor`);
          }
          const instance: unknown = Reflect.construct(Constructor, [options]);
          if (
            (typeof instance !== "object" || instance === null) &&
            typeof instance !== "function"
          ) {
            throw new TypeError(`Custom reporter ${name} did not create a reporter`);
          }
          reporter = instance;
        }
      }
      const onConsole: unknown = Reflect.get(reporter, "onUserConsoleLog");
      if (typeof onConsole === "function") {
        // Native reporters can replay buffered console logs from another hook.
        Reflect.set(reporter, "onUserConsoleLog", (...args: unknown[]) =>
          consoleCapture.run(true, () => Reflect.apply(onConsole, reporter, args)),
        );
      }
      const onInit: unknown = Reflect.get(reporter, "onInit");
      if (typeof onInit === "function") {
        await Reflect.apply(onInit, reporter, [context]);
      }
      this.reporters.push(reporter);
    }
  }

  private async forward(name: string, args: unknown[]) {
    const { error } = await this.initialization;
    if (error) {
      throw error;
    }
    const scrub: unknown = Reflect.get(scrubbers, name);
    if (typeof scrub === "function") {
      Reflect.apply(scrub, scrubbers, args);
    }
    await this.consoleCapture.run(name === "onUserConsoleLog", async () => {
      for (const reporter of this.reporters) {
        const hook: unknown = Reflect.get(reporter, name);
        if (typeof hook === "function") {
          await Reflect.apply(hook, reporter, args);
        }
      }
    });
  }
}
