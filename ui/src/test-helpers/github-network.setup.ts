import { chromium } from "playwright";
import "../../../test/setup.github-network.js";
import { installGitHubChromiumGuard } from "../../../test/helpers/github-browser-guard.mjs";

installGitHubChromiumGuard(chromium);
