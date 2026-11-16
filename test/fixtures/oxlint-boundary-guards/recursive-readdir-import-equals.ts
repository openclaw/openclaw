import fs = require("node:fs");
import promises = require("node:fs/promises");
fs.readdirSync("root", { recursive: true });
promises.readdir("root", { recursive: true });
fs.readdirSync("root", { recursive: false });
promises.readdir("root", { withFileTypes: true });
