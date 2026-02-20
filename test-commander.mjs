import { Command } from "commander";

const program = new Command();
program.name("test");

const placeholder = program.command("evo").description("lazy loaded evo");
placeholder.allowUnknownOption(true);
placeholder.allowExcessArguments(true);
placeholder.action(async (...actionArgs) => {
  console.log("Lazy loading evo! actionArgs:", actionArgs);

  // Remove placeholder
  const index = program.commands.indexOf(placeholder);
  if (index >= 0) {
    program.commands.splice(index, 1);
  }

  // Register real evo
  const realEvo = program.command("evo").description("real evo");
  realEvo.command("health").action(() => console.log("running health"));
  const daemon = realEvo.command("daemon").description("daemon cmd");
  daemon.command("start").action(() => console.log("running daemon start"));
  daemon.command("status").action(() => console.log("running daemon status"));

  // Reparse
  console.log("Reparsing with process.argv:", process.argv);
  await program.parseAsync(process.argv);
});

program.parseAsync(process.argv).catch((err) => {
  console.error("Parse Error:", err);
});
