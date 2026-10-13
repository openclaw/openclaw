# Lit → Solid golden corpus

`corpus.json` contains 40 complete tagged templates copied verbatim from 11
production UI files. Each records its source path and line at the migration
baseline. Expected JSX was authored independently of the codemod, retaining
literal text bytes (including whitespace) and existing expression behavior.

The corpus covers About and Debug route tags and views, native form properties,
boolean bindings, event callbacks, custom-element properties, i18n calls,
optional attributes, inline list rendering, style objects, SVG shapes, and
Unicode text. Synthetic cases in the test cover unsupported ownership work,
helper aliases, lexical shadowing, entity decoding, and keyed repetition.

`context.txt` supplies typed stand-ins for the surrounding page scope.
`custom-elements.d.ts` declares only the actual custom-element properties used;
native element attributes and Solid control flow use the installed Solid types.

Prepare and typecheck the actual generated output on the remote proof host:

```sh
node --import tsx test/fixtures/lit-to-solid/compile.mts
node scripts/run-tsgo.mjs -p .artifacts/solid2-p1-12/corpus/tsconfig.json
```

The focused golden suite is `pnpm test test/scripts/lit-to-solid.test.ts --maxWorkers=1`.
It also compiles and mounts a generated module in an isolated Node process with
the real Solid browser runtime. That contract covers nested control flow,
reactive updates, class coercion, object/primitive/function text without callback
execution, and DOM-node identity.
