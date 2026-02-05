import { useState } from 'react';
import { ThreeColumnLayout } from '../components/layout/ThreeColumnLayout';
import { Button, Input } from '../components/ui';
import styles from './SettingsView.module.css';

const navItems = [
  { id: 'preferences', label: 'Preferences' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keybindings', label: 'Keybindings' },
  { id: 'models', label: 'Models' },
  { id: 'skills', label: 'Skills' },
  { id: 'usage', label: 'Usage' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'git', label: 'Git' },
  { id: 'plugins', label: 'Plugins' },
];

export function SettingsView() {
  const [activeSection, setActiveSection] = useState('preferences');

  return (
    <ThreeColumnLayout
      sidebar={
        <nav className={styles.nav}>
          <div className={styles.navTitle}>Settings</div>
          {navItems.map((item) => (
            <div
              key={item.id}
              className={`${styles.navItem} ${activeSection === item.id ? styles.active : ''}`}
              onClick={() => setActiveSection(item.id)}
            >
              {item.label}
            </div>
          ))}
        </nav>
      }
      main={
        <div className={styles.content}>
          <h2 className={styles.sectionTitle}>Preferences</h2>

          <div className={styles.settingGroup}>
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <div className={styles.settingLabel}>Auto-save</div>
                <div className={styles.settingDescription}>Automatically save changes as you work</div>
              </div>
              <label className={styles.toggle}>
                <input type="checkbox" defaultChecked />
                <span className={styles.slider}></span>
              </label>
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <div className={styles.settingLabel}>Confirm before running commands</div>
                <div className={styles.settingDescription}>Show confirmation dialog before executing shell commands</div>
              </div>
              <label className={styles.toggle}>
                <input type="checkbox" defaultChecked />
                <span className={styles.slider}></span>
              </label>
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <div className={styles.settingLabel}>Default model</div>
                <div className={styles.settingDescription}>Model used for new conversations</div>
              </div>
              <select className={styles.select}>
                <option>claude-3-opus</option>
                <option>claude-3-sonnet</option>
                <option>claude-3-haiku</option>
              </select>
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <div className={styles.settingLabel}>Max workers</div>
                <div className={styles.settingDescription}>Maximum concurrent worker agents</div>
              </div>
              <Input type="number" defaultValue={4} className={styles.numberInput} />
            </div>
          </div>

          <div className={styles.actions}>
            <Button variant="secondary">Reset to defaults</Button>
            <Button>Save changes</Button>
          </div>
        </div>
      }
    />
  );
}
