// Lit emits a one-time dev-mode warning in test builds. Pre-mark it as issued
// so broad UI suites stay signal-heavy instead of repeating the same console.warn.
const issuedWarnings = ((globalThis as { litIssuedWarnings?: Set<string> }).litIssuedWarnings ??=
  new Set<string>());

issuedWarnings.add("dev-mode");

// JSDOM has no Web Animations API. Web Awesome uses this probe to skip
// animations when none are active.
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

// JSDOM exposes partial ElementInternals. Web Awesome form controls require
// the form-associated methods even when tests do not mount them in a form.
if (typeof HTMLElement !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "attachInternals", {
    configurable: true,
    value() {
      const validity = { valid: true } as ValidityState;
      return {
        checkValidity: () => true,
        form: null,
        labels: null,
        reportValidity: () => true,
        setFormValue: () => {},
        setValidity: () => {},
        states: new Set<string>(),
        validationMessage: "",
        validity,
        willValidate: true,
      };
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("showModal" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("close" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}
